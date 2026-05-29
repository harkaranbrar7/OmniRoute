/**
 * Basic unit tests for the tool-call translation layer
 * Run with: node --import tsx --test src/lib/translation/toolCallTranslator.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToolsToOpenAI,
  openAIToolCallsToAnthropic,
  anthropicToolResultsToOpenAI,
  extractToolIntent,
  buildToolIntentSystemInstruction,
  anthropicMessagesToOpenAI,
} from "./toolCallTranslator.js";

describe("anthropicToolsToOpenAI", () => {
  it("converts tool input_schema to function parameters", () => {
    const tools = [
      {
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ];
    const result = anthropicToolsToOpenAI(tools);
    assert.equal(result[0].type, "function");
    assert.equal(result[0].function.name, "search");
    assert.deepEqual(result[0].function.parameters, tools[0].input_schema);
  });
});

describe("openAIToolCallsToAnthropic", () => {
  it("parses tool_calls into tool_use blocks", () => {
    const toolCalls = [
      { id: "call_1", type: "function" as const, function: { name: "search", arguments: '{"query":"hello"}' } },
    ];
    const result = openAIToolCallsToAnthropic(toolCalls);
    assert.equal(result[0].type, "tool_use");
    assert.equal(result[0].id, "call_1");
    assert.deepEqual(result[0].input, { query: "hello" });
  });

  it("handles malformed JSON arguments gracefully", () => {
    const toolCalls = [
      { id: "call_2", type: "function" as const, function: { name: "search", arguments: "not-json" } },
    ];
    const result = openAIToolCallsToAnthropic(toolCalls);
    assert.equal(result[0].input.__raw, "not-json");
  });
});

describe("anthropicToolResultsToOpenAI", () => {
  it("converts string content", () => {
    const blocks = [{ type: "tool_result" as const, tool_use_id: "toolu_1", content: "result text" }];
    const result = anthropicToolResultsToOpenAI(blocks);
    assert.equal(result[0].role, "tool");
    assert.equal(result[0].tool_call_id, "toolu_1");
    assert.equal(result[0].content, "result text");
  });
});

describe("extractToolIntent", () => {
  it("extracts a valid tool intent from model text", () => {
    const text = `I need to search for this. {"tool_name": "search", "arguments": {"query": "OmniRoute"}}`;
    const intent = extractToolIntent(text);
    assert.ok(intent);
    assert.equal(intent.tool_name, "search");
    assert.deepEqual(intent.arguments, { query: "OmniRoute" });
  });

  it("returns null for plain text", () => {
    const intent = extractToolIntent("Just a normal response with no tool call.");
    assert.equal(intent, null);
  });
});

describe("buildToolIntentSystemInstruction", () => {
  it("includes all tool names", () => {
    const tools = [
      { name: "search", description: "Search", input_schema: {} },
      { name: "read_file", description: "Read a file", input_schema: {} },
    ];
    const instruction = buildToolIntentSystemInstruction(tools);
    assert.ok(instruction.includes("search"));
    assert.ok(instruction.includes("read_file"));
  });
});

describe("anthropicMessagesToOpenAI", () => {
  it("converts simple string messages", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there" },
    ];
    const result = anthropicMessagesToOpenAI(messages);
    assert.equal(result[0].role, "user");
    assert.equal(result[1].role, "assistant");
  });

  it("prepends system message when provided", () => {
    const result = anthropicMessagesToOpenAI([], "You are a helpful assistant.");
    assert.equal(result[0].role, "system");
    assert.equal(result[0].content, "You are a helpful assistant.");
  });
});
