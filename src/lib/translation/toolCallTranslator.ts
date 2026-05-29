/**
 * Tool-Call Translation Layer
 * Sits between Claude Code (/v1/messages Anthropic format)
 * and OmniRoute/provider (OpenAI chat completions format).
 *
 * Handles:
 *  - Anthropic tools[] input_schema  →  OpenAI tools[] function.parameters
 *  - OpenAI assistant tool_calls[]   →  Anthropic tool_use content blocks
 *  - Anthropic tool_result blocks    →  OpenAI role:"tool" messages
 *  - Tool-intent extraction for backends that don't support native function calling
 */

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | { type: string; text: string }[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface OpenAIToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Anthropic tools → OpenAI tools
// ─────────────────────────────────────────────────────────────────────────────
export function anthropicToolsToOpenAI(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OpenAI tool_calls → Anthropic tool_use blocks
// ─────────────────────────────────────────────────────────────────────────────
export function openAIToolCallsToAnthropic(
  toolCalls: OpenAIToolCall[]
): AnthropicToolUseBlock[] {
  return toolCalls.map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      // malformed JSON — pass raw as __raw
      input = { __raw: tc.function.arguments };
    }
    return {
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Anthropic tool_result blocks → OpenAI role:"tool" messages
// ─────────────────────────────────────────────────────────────────────────────
export function anthropicToolResultsToOpenAI(
  blocks: AnthropicToolResultBlock[]
): OpenAIToolMessage[] {
  return blocks.map((b) => ({
    role: "tool",
    tool_call_id: b.tool_use_id,
    content:
      typeof b.content === "string"
        ? b.content
        : b.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tool-intent extraction (for backends with no native function calling)
//    Parses model text output for a strict JSON tool intent block.
// ─────────────────────────────────────────────────────────────────────────────
export interface ToolIntent {
  tool_name: string;
  arguments: Record<string, unknown>;
}

export function extractToolIntent(text: string): ToolIntent | null {
  // Look for a JSON block anywhere in the text
  const jsonMatch = text.match(/\{[\s\S]*?"tool_name"[\s\S]*?\}/m);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ToolIntent>;
    if (
      typeof parsed.tool_name === "string" &&
      parsed.arguments &&
      typeof parsed.arguments === "object"
    ) {
      return { tool_name: parsed.tool_name, arguments: parsed.arguments };
    }
  } catch {
    // not valid JSON
  }
  return null;
}

/**
 * Build the system instruction injected when the backend has no native tool calling.
 * Tells the model to emit a strict JSON intent block when a tool is needed.
 */
export function buildToolIntentSystemInstruction(
  tools: AnthropicTool[]
): string {
  const toolList = tools
    .map((t) => `  - ${t.name}: ${t.description ?? "(no description)"})`)
    .join("\n");
  return [
    "You have access to the following tools:",
    toolList,
    "",
    "If you need to call a tool, respond with ONLY a single JSON object in this exact format:",
    '{ "tool_name": "<name>", "arguments": { <params> } }',
    "Do not include any other text when calling a tool.",
    "If you do not need a tool, respond normally.",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Convert a synthetic ToolIntent into an Anthropic tool_use block
// ─────────────────────────────────────────────────────────────────────────────
export function toolIntentToAnthropicToolUse(
  intent: ToolIntent,
  id: string
): AnthropicToolUseBlock {
  return {
    type: "tool_use",
    id,
    name: intent.tool_name,
    input: intent.arguments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Build a synthetic Anthropic stop_reason:"tool_use" response
// ─────────────────────────────────────────────────────────────────────────────
export function buildAnthropicToolUseResponse(
  toolUseBlocks: AnthropicToolUseBlock[],
  model = "claude-translated"
) {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: toolUseBlocks,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Conversation history converter
//    Translates Anthropic messages[] to OpenAI messages[]
// ─────────────────────────────────────────────────────────────────────────────
export interface AnthropicMessage {
  role: "user" | "assistant";
  content:
    | string
    | (AnthropicToolUseBlock | AnthropicToolResultBlock | { type: "text"; text: string })[];
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export function anthropicMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content blocks
    const toolUseBlocks = msg.content.filter(
      (b): b is AnthropicToolUseBlock => b.type === "tool_use"
    );
    const toolResultBlocks = msg.content.filter(
      (b): b is AnthropicToolResultBlock => b.type === "tool_result"
    );
    const textBlocks = msg.content.filter(
      (b): b is { type: "text"; text: string } => b.type === "text"
    );

    if (toolResultBlocks.length > 0) {
      // tool_result blocks become role:"tool" messages
      for (const tr of anthropicToolResultsToOpenAI(toolResultBlocks)) {
        result.push(tr);
      }
    } else if (toolUseBlocks.length > 0) {
      // assistant emitting tool_use → OpenAI assistant with tool_calls
      result.push({
        role: "assistant",
        content: textBlocks.map((b) => b.text).join("\n") || null,
        tool_calls: toolUseBlocks.map((b) => ({
          id: b.id,
          type: "function",
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        })),
      });
    } else {
      result.push({
        role: msg.role,
        content: textBlocks.map((b) => b.text).join("\n"),
      });
    }
  }

  return result;
}
