/**
 * /v1/messages — Anthropic-compatible endpoint
 *
 * Routes:
 *  - model starts with "pplx-" → pplxToolLoop (full self-contained tool loop
 *    against Perplexity web, handles tool_use / tool_result entirely in middleware)
 *  - all other models → ToolCallAdapter (standard Anthropic ↔ OpenAI translation)
 *
 * Claude Code configuration:
 *   Base URL:  http://localhost:20128/v1
 *   API Key:   <your OmniRoute key>
 *   Model:     pplx-sonar  (or pplx-auto, pplx-gpt, pplx-sonnet, pplx-gemini)
 */

import { NextRequest, NextResponse } from "next/server";
import { ToolCallAdapter } from "@/lib/translation/toolCallAdapter";
import { runPplxToolLoop } from "@/lib/translation/pplxToolLoop";
import type { AnthropicRequest } from "@/lib/translation/toolCallAdapter";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY ?? "";

// Standard adapter for non-Perplexity providers
const adapter = new ToolCallAdapter({
  useIntentExtraction: false,
  omniRouteBaseUrl: BASE_URL,
  omniRouteApiKey: API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnthropicRequest;

    if (!body.model || !Array.isArray(body.messages)) {
      return NextResponse.json(
        { error: { type: "invalid_request_error", message: "model and messages are required" } },
        { status: 400 }
      );
    }

    let result: Record<string, unknown>;

    // ── Perplexity web: use dedicated tool loop ──
    if (body.model.startsWith("pplx-")) {
      result = await runPplxToolLoop(body, {
        omniRouteBaseUrl: BASE_URL,
        omniRouteApiKey: API_KEY,
        maxIterations: 5,
      });
    } else {
      // ── All other providers: standard OpenAI↔Anthropic adapter ──
      result = await adapter.forward(body);
    }

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

export async function GET() {
  return NextResponse.json({
    status: "ok",
    layer: "tool-call-translation",
    pplxModels: ["pplx-auto", "pplx-sonar", "pplx-gpt", "pplx-sonnet", "pplx-gemini", "pplx-opus"],
    note: "pplx-* models use the full self-contained tool loop via Perplexity web",
  });
}
