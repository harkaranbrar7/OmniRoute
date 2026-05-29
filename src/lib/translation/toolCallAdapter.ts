/**
 * Tool-Call Adapter — Express/Next.js compatible middleware
 *
 * POST /v1/messages  (Anthropic format from Claude Code)
 *   ↓  translateRequest()
 * POST /v1/chat/completions  (OpenAI format to OmniRoute/provider)
 *   ↓  translateResponse()
 * Anthropic messages response back to Claude Code
 *
 * Usage in Next.js API route (app/api/v1/messages/route.ts):
 *   import { ToolCallAdapter } from "@/lib/translation/toolCallAdapter";
 */

import { randomUUID } from "crypto";
import {
  AnthropicTool,
  AnthropicMessage,
  AnthropicToolUseBlock,
  OpenAIMessage,
  OpenAIToolCall,
  anthropicToolsToOpenAI,
  anthropicMessagesToOpenAI,
  openAIToolCallsToAnthropic,
  buildAnthropicToolUseResponse,
  extractToolIntent,
  buildToolIntentSystemInstruction,
  toolIntentToAnthropicToolUse,
} from "./toolCallTranslator";

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  system?: string;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: ReturnType<typeof anthropicToolsToOpenAI>;
  tool_choice?: string;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

export interface AdapterOptions {
  /**
   * If true, the backend does NOT support native function calling.
   * The adapter will inject a system prompt for tool-intent extraction.
   */
  useIntentExtraction?: boolean;

  /**
   * Downstream OmniRoute base URL
   */
  omniRouteBaseUrl?: string;

  /**
   * OmniRoute API key
   */
  omniRouteApiKey?: string;
}

export class ToolCallAdapter {
  private options: AdapterOptions;

  // In-memory state: maps tool_use IDs to tool names for the current turn
  private pendingToolCalls = new Map<string, string>();

  constructor(options: AdapterOptions = {}) {
    this.options = {
      useIntentExtraction: false,
      omniRouteBaseUrl: process.env.BASE_URL ?? "http://localhost:20128",
      omniRouteApiKey: process.env.OMNIROUTE_API_KEY ?? "",
      ...options,
    };
  }

  // ─── Translate Anthropic request → OpenAI request ──────────────────────────
  translateRequest(req: AnthropicRequest): OpenAIChatRequest {
    this.pendingToolCalls.clear();

    let systemPrompt = req.system;

    // If backend has no native tool calling, inject intent extraction instructions
    if (this.options.useIntentExtraction && req.tools?.length) {
      const intentInstruction = buildToolIntentSystemInstruction(req.tools);
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${intentInstruction}`
        : intentInstruction;
    }

    const openAIMessages = anthropicMessagesToOpenAI(
      req.messages,
      systemPrompt
    );

    const openAIReq: OpenAIChatRequest = {
      model: req.model,
      messages: openAIMessages,
      max_tokens: req.max_tokens,
      stream: req.stream,
      temperature: req.temperature,
      top_p: req.top_p,
    };

    // Add tools if backend supports native function calling
    if (!this.options.useIntentExtraction && req.tools?.length) {
      openAIReq.tools = anthropicToolsToOpenAI(req.tools);
      openAIReq.tool_choice = "auto";
    }

    return openAIReq;
  }

  // ─── Translate OpenAI response → Anthropic response ────────────────────────
  translateResponse(
    openAIResponse: Record<string, unknown>,
    originalRequest: AnthropicRequest
  ): Record<string, unknown> {
    const choice = (openAIResponse.choices as Array<Record<string, unknown>>)?.[0];
    if (!choice) return openAIResponse;

    const message = choice.message as Record<string, unknown>;
    const finishReason = choice.finish_reason as string;

    // ── Case 1: Native tool_calls in OpenAI response ──
    if (
      finishReason === "tool_calls" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    ) {
      const toolUseBlocks = openAIToolCallsToAnthropic(
        message.tool_calls as OpenAIToolCall[]
      );
      // Track pending calls
      for (const b of toolUseBlocks) {
        this.pendingToolCalls.set(b.id, b.name);
      }
      return buildAnthropicToolUseResponse(
        toolUseBlocks,
        originalRequest.model
      );
    }

    // ── Case 2: Intent extraction (no native tool calling) ──
    const textContent =
      typeof message.content === "string"
        ? message.content
        : (message.content as Array<{ text?: string }>)
            ?.map((c) => c.text ?? "")
            .join("") ?? "";

    if (this.options.useIntentExtraction && originalRequest.tools?.length) {
      const intent = extractToolIntent(textContent);
      if (intent) {
        const toolUseId = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const toolUseBlock = toolIntentToAnthropicToolUse(intent, toolUseId);
        this.pendingToolCalls.set(toolUseId, intent.tool_name);
        return buildAnthropicToolUseResponse(
          [toolUseBlock],
          originalRequest.model
        );
      }
    }

    // ── Case 3: Regular text response ──
    const usage = openAIResponse.usage as Record<string, number> | undefined;
    return {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: originalRequest.model,
      content: [{ type: "text", text: textContent }],
      stop_reason: finishReason === "stop" ? "end_turn" : finishReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    };
  }

  // ─── Forward to OmniRoute and return translated Anthropic response ──────────
  async forward(
    anthropicReq: AnthropicRequest
  ): Promise<Record<string, unknown>> {
    const openAIReq = this.translateRequest(anthropicReq);

    const res = await fetch(
      `${this.options.omniRouteBaseUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.omniRouteApiKey}`,
        },
        body: JSON.stringify(openAIReq),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OmniRoute upstream error ${res.status}: ${err}`);
    }

    const openAIResponse = (await res.json()) as Record<string, unknown>;
    return this.translateResponse(openAIResponse, anthropicReq);
  }

  getPendingToolCalls() {
    return new Map(this.pendingToolCalls);
  }
}
