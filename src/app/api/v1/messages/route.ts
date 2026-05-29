/**
 * /v1/messages — Anthropic-compatible endpoint
 *
 * Accepts Claude Code / OpenCode requests in Anthropic format,
 * translates them to OpenAI format, forwards to OmniRoute,
 * and returns an Anthropic-format response.
 *
 * Supports:
 *  - Native function calling (when provider supports tool_calls)
 *  - Tool-intent extraction (for plain-text backends like Perplexity web)
 */

import { NextRequest, NextResponse } from "next/server";
import { ToolCallAdapter } from "@/lib/translation/toolCallAdapter";
import type { AnthropicRequest } from "@/lib/translation/toolCallAdapter";

// Set USE_INTENT_EXTRACTION=true in .env if using a backend
// that does NOT natively support function calling (e.g. Perplexity web)
const USE_INTENT_EXTRACTION =
  process.env.USE_INTENT_EXTRACTION === "true" ||
  process.env.USE_INTENT_EXTRACTION === "1";

const adapter = new ToolCallAdapter({
  useIntentExtraction: USE_INTENT_EXTRACTION,
  omniRouteBaseUrl: process.env.BASE_URL ?? "http://localhost:20128",
  omniRouteApiKey: process.env.OMNIROUTE_API_KEY ?? "",
});

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnthropicRequest;

    // Validate minimum required fields
    if (!body.model || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: { type: "invalid_request_error", message: "model and messages are required" } },
        { status: 400 }
      );
    }

    const result = await adapter.forward(body);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal translation error";
    console.error("[translation-layer] error:", message);
    return NextResponse.json(
      { error: { type: "api_error", message } },
      { status: 500 }
    );
  }
}

// Health check
export async function GET() {
  return NextResponse.json({
    status: "ok",
    layer: "tool-call-translation",
    useIntentExtraction: USE_INTENT_EXTRACTION,
  });
}
