/**
 * /v1/messages  —  Anthropic-compatible endpoint
 *
 * Routes:
 *   pplx-*   model  →  runPplxToolLoop (Perplexity web, full tool-call loop)
 *   all other models →  plain proxy / future adapter
 *
 * Claude Code setup:
 *   Base URL : http://localhost:20128/v1
 *   API Key  : <your OmniRoute API key>
 *   Model    : pplx-sonar  (or pplx-auto, pplx-gpt, pplx-sonnet, pplx-gemini)
 */

import { NextRequest, NextResponse } from "next/server";
import {
  runPplxToolLoop,
  type AnthropicRequest,
} from "@/lib/translation/pplxToolLoop";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:20128";
const API_KEY = process.env.OMNIROUTE_API_KEY ?? "";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AnthropicRequest;

    if (!body.model || !Array.isArray(body.messages)) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_request_error",
            message: "model and messages are required",
          },
        },
        { status: 400 }
      );
    }

    // ── Perplexity web: dedicated tool-call loop ──────────────────────────
    if (body.model.startsWith("pplx-")) {
      const result = await runPplxToolLoop(body, {
        omniRouteBaseUrl: BASE_URL,
        omniRouteApiKey: API_KEY,
        maxIterations: 5,
      });
      return NextResponse.json(result);
    }

    // ── Other providers: TODO — add adapters here as needed ───────────────
    return NextResponse.json(
      {
        error: {
          type: "not_implemented",
          message: `Model ${body.model} is not yet supported by the translation layer. Use a pplx-* model for Perplexity web.`,
        },
      },
      { status: 501 }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Internal translation error";
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
    layer: "pplx-tool-call-translation",
    pplxModels: [
      "pplx-auto",
      "pplx-sonar",
      "pplx-gpt",
      "pplx-sonnet",
      "pplx-gemini",
      "pplx-opus",
      "pplx-nemotron",
    ],
  });
}
