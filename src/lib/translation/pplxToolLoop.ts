/**
 * pplxToolLoop.ts  —  Self-contained Perplexity tool-call loop
 *
 * No external imports. All types, helpers, and logic live here.
 *
 * How it works:
 *   Perplexity has no native function-calling. This module fakes it by:
 *   1. Injecting a strict JSON-only system prompt listing available tools
 *   2. Sending the full conversation to Perplexity via OmniRoute /v1/chat/completions
 *   3. Parsing the response for a { tool_name, arguments } JSON block
 *   4. If found: returning stop_reason:"tool_use" to Claude Code
 *   5. On the next turn (tool_result): serialising the result as plain user text
 *      and sending back to Perplexity for the final answer
 */

import { randomUUID } from "crypto";

// ─── Anthropic wire types ────────────────────────────────────────────────────

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

interface TextBlock      { type: "text"; text: string }
interface ToolUseBlock   { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  max_tokens?: number;
  stream?: boolean;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface PplxLoopOptions {
  omniRouteBaseUrl: string;
  omniRouteApiKey: string;
  /** Hard ceiling on tool-call iterations before forcing a plain text answer */
  maxIterations?: number;
}

// ─── Internal OpenAI message shape ───────────────────────────────────────────

interface OAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Tool intent parsing ─────────────────────────────────────────────────────

interface ToolIntent {
  tool_name: string;
  arguments: Record<string, unknown>;
}

/**
 * Scan the model response for a JSON object containing tool_name + arguments.
 * Accepts fenced code blocks (```json … ```) or bare JSON anywhere in the text.
 */
function extractToolIntent(text: string): ToolIntent | null {
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fenced ? [fenced[1]] : [];

  // Also try every {...} span in the response
  const bareMatches = text.matchAll(/\{[\s\S]*?\}/g);
  for (const m of bareMatches) candidates.push(m[0]);

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (
        typeof parsed.tool_name === "string" &&
        parsed.tool_name.length > 0 &&
        typeof parsed.arguments === "object" &&
        parsed.arguments !== null
      ) {
        return {
          tool_name: parsed.tool_name,
          arguments: parsed.arguments as Record<string, unknown>,
        };
      }
    } catch {
      // not valid JSON, keep trying
    }
  }
  return null;
}

// ─── System prompt builder ────────────────────────────────────────────────────

function buildSystemPrompt(tools: AnthropicTool[], base?: string): string {
  const toolDefs = tools
    .map((t) => {
      const props = t.input_schema?.properties
        ? Object.entries(t.input_schema.properties)
            .map(([k, v]) => `    - ${k} (${v.type ?? "any"}): ${v.description ?? ""}`)
            .join("\n")
        : "    (no parameters)";
      const required = t.input_schema?.required?.join(", ") ?? "none";
      return [
        `## Tool: ${t.name}`,
        t.description ? `Description: ${t.description}` : "",
        `Parameters:\n${props}`,
        `Required: ${required}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const instruction = [
    "You have access to the following tools:",
    "",
    toolDefs,
    "",
    "RULES (follow exactly):",
    '1. If you need to call a tool, respond with ONLY a JSON object — no prose before or after:',
    '   { "tool_name": "<name>", "arguments": { <key>: <value> } }',
    "2. If no tool is needed, respond in plain text as normal.",
    "3. Never mix JSON and prose in the same response.",
    "4. The JSON must be the entire response — no explanation, no markdown wrapper.",
  ].join("\n");

  return [base?.trim(), instruction].filter(Boolean).join("\n\n");
}

// ─── Message builder ──────────────────────────────────────────────────────────

/**
 * Convert Anthropic messages[] to a flat OpenAI-style array that Perplexity
 * can understand. tool_use / tool_result blocks are serialised as readable text
 * since Perplexity has no native function-calling protocol.
 */
function toOAIMessages(
  messages: AnthropicMessage[],
  systemPrompt: string
): OAIMessage[] {
  const result: OAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    // Plain string content
    if (typeof msg.content === "string") {
      result.push({ role: msg.role === "user" ? "user" : "assistant", content: msg.content });
      continue;
    }

    const blocks = msg.content as ContentBlock[];

    // tool_result blocks (role:user) → human-readable text fed back to Perplexity
    const toolResults = blocks.filter(
      (b): b is ToolResultBlock => b.type === "tool_result"
    );
    if (toolResults.length > 0) {
      const formatted = toolResults
        .map((r) => {
          const body =
            typeof r.content === "string"
              ? r.content
              : r.content
                  .map((c) => ("text" in c ? (c as { text: string }).text : ""))
                  .join("\n");
          return `[Tool result for call ${r.tool_use_id}]:\n${body}`;
        })
        .join("\n\n");
      result.push({
        role: "user",
        content: `The tool returned the following result. Use it to answer the user:\n\n${formatted}`,
      });
      continue;
    }

    // tool_use blocks (role:assistant) → show as assistant message
    const toolUse = blocks.filter((b) => b.type === "tool_use") as ToolUseBlock[];
    const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");

    if (toolUse.length > 0) {
      const callDesc = toolUse
        .map((b) => `[Called tool ${b.name} with: ${JSON.stringify(b.input)}]`)
        .join("\n");
      const text = textBlocks.map((b) => b.text).join("\n");
      result.push({
        role: "assistant",
        content: [text, callDesc].filter(Boolean).join("\n"),
      });
      continue;
    }

    // Plain text blocks
    const text = textBlocks.map((b) => b.text).join("\n");
    if (text) {
      result.push({ role: msg.role === "user" ? "user" : "assistant", content: text });
    }
  }

  return result;
}

// ─── OmniRoute caller ─────────────────────────────────────────────────────────

async function callOmniRoute(
  messages: OAIMessage[],
  model: string,
  opts: PplxLoopOptions
): Promise<string> {
  const res = await fetch(`${opts.omniRouteBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.omniRouteApiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`OmniRoute error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── Response builders ────────────────────────────────────────────────────────

function textResponse(text: string, model: string): Record<string, unknown> {
  return {
    id: `msg_pplx_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.ceil(text.length / 4),
      output_tokens: Math.ceil(text.length / 4),
    },
  };
}

function toolUseResponse(
  intent: ToolIntent,
  model: string
): Record<string, unknown> {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id: `msg_pplx_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: intent.tool_name,
        input: intent.arguments,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Run the full agentic tool-call loop against Perplexity web via OmniRoute.
 *
 * Handles three cases:
 *   A) No tools in request  → plain passthrough, returns text response
 *   B) Tools present, last message has tool_results → feed results back, get final answer
 *   C) Tools present, fresh request → ask Perplexity for tool JSON or plain answer
 */
export async function runPplxToolLoop(
  req: AnthropicRequest,
  opts: PplxLoopOptions
): Promise<Record<string, unknown>> {
  const model = req.model;
  const tools = req.tools ?? [];
  const maxIter = opts.maxIterations ?? 5;

  // Case A: no tools — plain passthrough
  if (tools.length === 0) {
    const sysPrompt = req.system ?? "";
    const msgs = toOAIMessages(req.messages, sysPrompt);
    const text = await callOmniRoute(msgs, model, opts);
    return textResponse(text, model);
  }

  // Case B / C: tools exist — always build system prompt with tool list
  const sysPrompt = buildSystemPrompt(tools, req.system);
  const msgs = toOAIMessages(req.messages, sysPrompt);
  const text = await callOmniRoute(msgs, model, opts);

  // If Perplexity returned a tool intent JSON, return tool_use to Claude Code
  const intent = extractToolIntent(text);
  if (intent && maxIter > 0) {
    return toolUseResponse(intent, model);
  }

  // No tool call — return plain text answer
  return textResponse(text, model);
}
