/**
 * pplxToolLoop.ts
 * ================
 * Full agentic tool-call loop for Perplexity Web.
 *
 * Problem:
 *   perplexity-web.ts executor drops all tool_calls / tool messages because
 *   parseOpenAIMessages() only handles role:"user" and role:"assistant" text.
 *   Perplexity has no native function-calling — it only returns plain markdown.
 *
 * Solution:
 *   This module intercepts the request BEFORE it reaches the executor.
 *   It runs the entire tool loop itself:
 *
 *   1. Inject a strict JSON tool-call system prompt into the query
 *   2. Send to Perplexity via OmniRoute → perplexity-web
 *   3. Parse the response for a tool-intent JSON block
 *   4. If found: synthesize Anthropic tool_use → return to Claude Code
 *   5. Claude Code executes the tool, sends back tool_result
 *   6. Adapter converts tool_result back into a follow-up Perplexity message
 *   7. Repeat until Perplexity returns plain text (no tool call)
 *
 * This means the translation layer owns the ENTIRE tool state machine.
 * Perplexity is treated as a dumb text backend.
 */

import { randomUUID } from "crypto";
import type { AnthropicRequest } from "./toolCallAdapter.js";
import {
  anthropicToolsToOpenAI,
  buildToolIntentSystemInstruction,
  extractToolIntent,
  toolIntentToAnthropicToolUse,
  buildAnthropicToolUseResponse,
  type AnthropicTool,
  type AnthropicMessage,
  type AnthropicToolResultBlock,
} from "./toolCallTranslator.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PplxLoopOptions {
  omniRouteBaseUrl: string;
  omniRouteApiKey: string;
  /** Max tool-call iterations before forcing a final answer */
  maxIterations?: number;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

// ─── Message builder ─────────────────────────────────────────────────────────

/**
 * Converts an Anthropic messages[] array into OpenAI messages[],
 * specifically handling:
 *  - tool_use blocks in assistant messages → openai tool_calls
 *  - tool_result blocks in user messages → role:"tool" messages
 *  - Serialises tool results as readable text back into the conversation
 *    so Perplexity can understand what happened
 */
function buildPplxMessages(
  anthropicMessages: AnthropicMessage[],
  systemPrompt: string
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content;

    // tool_result blocks → inject as user message with readable tool output
    const toolResults = blocks.filter(
      (b): b is AnthropicToolResultBlock => b.type === "tool_result"
    );
    if (toolResults.length > 0) {
      const formatted = toolResults
        .map((r) => {
          const content =
            typeof r.content === "string"
              ? r.content
              : r.content.map((c) => ("text" in c ? c.text : "")).join("\n");
          return `[Tool result for ${r.tool_use_id}]:\n${content}`;
        })
        .join("\n\n");
      // Perplexity sees this as a user message feeding back the tool output
      result.push({
        role: "user",
        content: `The tool returned the following result. Use it to continue:\n\n${formatted}`,
      });
      continue;
    }

    // tool_use blocks → format as assistant message showing what it called
    const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");
    const textBlocks = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text");

    if (toolUseBlocks.length > 0) {
      const calls = toolUseBlocks
        .map((b) => {
          if (b.type !== "tool_use") return "";
          return `[Called tool ${b.name} with: ${JSON.stringify(b.input)}]`;
        })
        .join("\n");
      const text = textBlocks.map((b) => b.text).join("\n");
      result.push({
        role: "assistant",
        content: [text, calls].filter(Boolean).join("\n"),
      });
      continue;
    }

    // Plain text blocks
    const text = textBlocks.map((b) => b.text).join("\n");
    if (text) result.push({ role: msg.role, content: text });
  }

  return result;
}

// ─── OmniRoute forwarder ─────────────────────────────────────────────────────

/**
 * Sends a plain OpenAI chat/completions request to OmniRoute
 * targeting the perplexity-web executor.
 * Returns the assistant text content.
 */
async function callPplxViaOmniRoute(
  messages: OpenAIMessage[],
  model: string,
  opts: PplxLoopOptions
): Promise<string> {
  const body = {
    model,
    messages,
    stream: false,
  };

  const res = await fetch(`${opts.omniRouteBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.omniRouteApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OmniRoute/pplx error ${res.status}: ${err}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? "";
}

// ─── Tool-call system prompt ─────────────────────────────────────────────────

function buildPplxSystemPrompt(tools: AnthropicTool[], baseSystem?: string): string {
  const toolInstruction = buildToolIntentSystemInstruction(tools);

  // Extra enforcement: tell Perplexity to respond ONLY with the JSON when calling
  const enforcement = [
    "",
    "CRITICAL RULES:",
    "1. If a tool is needed, output ONLY the JSON object. No explanation before or after.",
    "2. The JSON must start with { and end with }.",
    '3. Use this EXACT format: { "tool_name": "<name>", "arguments": { ... } }',
    "4. If no tool is needed, respond normally in plain text.",
    "5. Never mix tool JSON with prose in the same response.",
  ].join("\n");

  return [baseSystem, toolInstruction, enforcement].filter(Boolean).join("\n\n");
}

// ─── Main loop ───────────────────────────────────────────────────────────────

/**
 * Run the full tool-call agentic loop against Perplexity web.
 *
 * - If the request has no tools, forwards directly and returns an Anthropic text response.
 * - If the request has tools, runs up to maxIterations asking Perplexity for tool JSON,
 *   then returns stop_reason:"tool_use" for Claude Code to execute.
 * - After Claude Code feeds back tool_result, the next call continues the loop.
 */
export async function runPplxToolLoop(
  req: AnthropicRequest,
  opts: PplxLoopOptions
): Promise<Record<string, unknown>> {
  const maxIter = opts.maxIterations ?? 1;
  const model = req.model;
  const tools = req.tools ?? [];

  // ── No tools: plain passthrough ──
  if (tools.length === 0) {
    const messages = buildPplxMessages(req.messages, req.system ?? "");
    const text = await callPplxViaOmniRoute(messages, model, opts);
    return buildAnthropicTextResponse(text, model);
  }

  // ── Check if the latest user turn contains tool_results (continuation) ──
  // In that case, we already sent tool_use to Claude Code in a previous turn.
  // Now we need to feed the results back to Perplexity and get the final answer.
  const lastMsg = req.messages[req.messages.length - 1];
  const hasToolResults =
    Array.isArray(lastMsg?.content) &&
    lastMsg.content.some((b) => b.type === "tool_result");

  if (hasToolResults) {
    // Build the full conversation including tool results serialized as text
    const systemPrompt = buildPplxSystemPrompt(tools, req.system);
    const messages = buildPplxMessages(req.messages, systemPrompt);
    const text = await callPplxViaOmniRoute(messages, model, opts);

    // Check if Perplexity wants another tool call
    const intent = extractToolIntent(text);
    if (intent && maxIter > 0) {
      const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const toolUseBlock = toolIntentToAnthropicToolUse(intent, toolUseId);
      return buildAnthropicToolUseResponse([toolUseBlock], model);
    }

    // No more tool calls — return final text answer
    return buildAnthropicTextResponse(text, model);
  }

  // ── Fresh request with tools: ask Perplexity for first tool call ──
  const systemPrompt = buildPplxSystemPrompt(tools, req.system);
  const messages = buildPplxMessages(req.messages, systemPrompt);
  const text = await callPplxViaOmniRoute(messages, model, opts);

  const intent = extractToolIntent(text);
  if (intent) {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const toolUseBlock = toolIntentToAnthropicToolUse(intent, toolUseId);
    return buildAnthropicToolUseResponse([toolUseBlock], model);
  }

  // Perplexity answered directly without a tool call
  return buildAnthropicTextResponse(text, model);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAnthropicTextResponse(
  text: string,
  model: string
): Record<string, unknown> {
  return {
    id: `msg_${Date.now()}`,
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
