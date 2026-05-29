# Tool-Call Translation Layer

This module sits between **Claude Code / OpenCode** (Anthropic `/v1/messages` format) and **OmniRoute / provider** (OpenAI `/v1/chat/completions` format). It implements the full tool-call state machine described in the Anthropic tool-use docs.

## Files

| File | Purpose |
|---|---|
| `toolCallTranslator.ts` | Pure translation functions (no I/O, fully testable) |
| `toolCallAdapter.ts` | Stateful adapter class — wraps translator, manages pending call IDs, forwards to OmniRoute |
| `toolCallTranslator.test.ts` | Unit tests |

The Next.js API route is at `src/app/api/v1/messages/route.ts`.

---

## How It Works

```
Claude Code
  POST /v1/messages  (Anthropic format)
        │
        ▼
  ToolCallAdapter.translateRequest()
   - Converts tools[].input_schema  →  tools[].function.parameters
   - Converts messages[]            →  OpenAI messages[]
   - Injects system prompt for intent extraction (if needed)
        │
        ▼
  OmniRoute  POST /v1/chat/completions
        │
        ▼
  ToolCallAdapter.translateResponse()
   - Native tool_calls[]  →  Anthropic tool_use blocks  (stop_reason: tool_use)
   - Intent JSON in text  →  Anthropic tool_use blocks  (intent extraction mode)
   - Plain text           →  Anthropic text content     (stop_reason: end_turn)
        │
        ▼
  Claude Code  ←  Anthropic-format response
```

---

## Two Modes

### Mode 1: Native Function Calling (default)
Use when OmniRoute routes to a provider that supports `tool_calls` (GPT-4, Claude, Gemini, etc.).

```env
# .env — no extra config needed, this is the default
USE_INTENT_EXTRACTION=false
```

### Mode 2: Tool-Intent Extraction
Use when routing through a backend that returns plain text (e.g. Perplexity web, older models).

```env
# .env
USE_INTENT_EXTRACTION=true
```

In this mode, the adapter injects a system instruction telling the model to emit:
```json
{ "tool_name": "search", "arguments": { "query": "..." } }
```
...instead of native function calls. The adapter parses that JSON, converts it to an Anthropic `tool_use` block, and runs the tool loop.

---

## Translation Rules

| Claude Code (Anthropic) | Middleware | Provider (OpenAI) |
|---|---|---|
| `tools[].input_schema` | → | `tools[].function.parameters` |
| `assistant.content[].tool_use` | → | `assistant.tool_calls[]` |
| `tool_use.id` | stored in state | same ID as `tool_call_id` |
| `user.content[].tool_result` | → | `{ role: "tool", tool_call_id }` |

---

## Tool Loop (Claude Spec)

1. Claude Code sends `tools[]` + `messages[]`
2. Adapter translates → OmniRoute → provider
3. Provider returns `tool_calls` (or intent JSON)
4. Adapter responds with `stop_reason: "tool_use"` + `tool_use` blocks
5. Claude Code executes tools, sends back `tool_result` blocks
6. Adapter translates those into `role: "tool"` messages, forwards again
7. Repeat until `stop_reason: "end_turn"`

---

## Point Claude Code at This Layer

```
Base URL:  http://localhost:20128/v1
API Key:   <your OmniRoute key>
Model:     auto  (or any provider/model)
```

The `/v1/messages` route is now handled by the translation layer.

---

## Run Tests

```bash
node --import tsx --test src/lib/translation/toolCallTranslator.test.ts
```
