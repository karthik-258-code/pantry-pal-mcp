import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockMcpAgent,
  cleanModelText,
  mcpResultToToolResult,
  mcpToolsToBedrock,
  toBedrockToolName,
  type McpToolSource,
} from "../src/index.js";

// ---------- helpers ----------

const tool = (name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }, description = `desc ${name}`) =>
  ({ name, description, inputSchema }) as never;

/** Fake Bedrock client that replays scripted responses and records requests. */
function fakeBedrock(responses: Array<Partial<ConverseCommandOutput>>) {
  const requests: ConverseCommand["input"][] = [];
  let i = 0;
  return {
    requests,
    send: async (cmd: ConverseCommand) => {
      requests.push(structuredClone(cmd.input));
      const r = responses[Math.min(i++, responses.length - 1)];
      return r as unknown as ConverseCommandOutput;
    },
  };
}

const toolUse = (name: string, input: unknown, id = "tu-1"): Partial<ConverseCommandOutput> => ({
  stopReason: "tool_use",
  output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: id, name, input: input as never } }] } },
});
const say = (text: string): Partial<ConverseCommandOutput> => ({
  stopReason: "end_turn",
  output: { message: { role: "assistant", content: [{ text }] } },
});

function fakeMcp(tools: unknown[], impl: (name: string, args: Record<string, unknown>) => unknown): McpToolSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listTools: async () => ({ tools: tools as never }),
    callTool: async ({ name, arguments: args }) => {
      calls.push(name);
      return impl(name, args ?? {});
    },
  };
}

// ---------- mapping ----------

test("maps MCP tools to Bedrock toolSpecs and drops $schema", () => {
  const { toolConfig } = mcpToolsToBedrock([
    tool("get_weather", { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  ]);
  const spec = toolConfig.tools?.[0]?.toolSpec;
  assert.equal(spec?.name, "get_weather");
  assert.equal(spec?.description, "desc get_weather");
  const json = (spec?.inputSchema as { json: Record<string, unknown> }).json;
  assert.equal(json.$schema, undefined);
  assert.deepEqual(json.required, ["city"]);
  assert.equal(json.type, "object");
});

test("sanitises invalid names and de-duplicates collisions", () => {
  const { toolConfig, toMcpName } = mcpToolsToBedrock([tool("files.read"), tool("files/read")]);
  const names = toolConfig.tools?.map((t) => t.toolSpec?.name);
  assert.deepEqual(names, ["files_read", "files_read_2"]);
  assert.equal(toMcpName.get("files_read"), "files.read");
  assert.equal(toMcpName.get("files_read_2"), "files/read");
});

test("truncates long names to 64 characters", () => {
  assert.equal(toBedrockToolName("x".repeat(100)).length, 64);
  assert.equal(toBedrockToolName(""), "tool");
});

test("falls back to the tool name when there is no description", () => {
  const { toolConfig } = mcpToolsToBedrock([tool("ping", undefined, "")]);
  assert.equal(toolConfig.tools?.[0]?.toolSpec?.description, "ping");
});

// ---------- result conversion ----------

test("converts text, images and structured content", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const block = mcpResultToToolResult("id-1", {
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: png, mimeType: "image/png" },
      { type: "image", data: png, mimeType: "image/tiff" },
    ],
    structuredContent: { temp: 21 },
  });
  const content = block.toolResult?.content ?? [];
  assert.equal(block.toolResult?.toolUseId, "id-1");
  assert.deepEqual(content[0], { text: "hello" });
  assert.equal((content[1] as { image: { format: string; source: { bytes: Uint8Array } } }).image.format, "png");
  assert.equal((content[1] as { image: { source: { bytes: Uint8Array } } }).image.source.bytes.length, 4);
  assert.match((content[2] as { text: string }).text, /not supported/);
  assert.deepEqual(content[3], { json: { temp: 21 } });
  assert.equal(block.toolResult?.status, undefined);
});

test("marks errors with a prefix, or with status when requested", () => {
  const err = { content: [{ type: "text", text: "boom" }], isError: true };
  assert.deepEqual(mcpResultToToolResult("a", err).toolResult?.content?.[0], { text: "ERROR: boom" });
  const withStatus = mcpResultToToolResult("a", err, { includeStatus: true }).toolResult;
  assert.equal(withStatus?.status, "error");
  assert.deepEqual(withStatus?.content?.[0], { text: "boom" });
});

test("handles empty results", () => {
  assert.deepEqual(mcpResultToToolResult("a", {}).toolResult?.content, [{ text: "(no content)" }]);
});

test("cleanModelText strips <thinking> and <response> wrappers", () => {
  assert.equal(cleanModelText("<thinking>plan</thinking><response> Sunny. </response>"), "Sunny.");
});

// ---------- agent loop ----------

test("runs the tool-use loop and maps names back to MCP", async () => {
  const mcp = fakeMcp([tool("get.weather")], (_name, args) => ({ content: [{ type: "text", text: `22C in ${args.city}` }] }));
  const bedrock = fakeBedrock([toolUse("get_weather", { city: "Paris" }), say("<thinking>ok</thinking>It's 22C in Paris.")]);
  const seen: string[] = [];
  const agent = new BedrockMcpAgent({ mcp, bedrock, modelId: "test-model", system: "be brief", onToolCall: (c) => seen.push(c.name) });

  const res = await agent.run("Weather in Paris?");

  assert.equal(res.text, "It's 22C in Paris.");
  assert.deepEqual(mcp.calls, ["get.weather"]);
  assert.deepEqual(seen, ["get.weather"]);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.steps, 2);
  assert.equal(agent.messages.length, 4); // user, assistant(toolUse), user(toolResult), assistant

  const second = bedrock.requests[1];
  const toolResult = second.messages?.[2]?.content?.[0]?.toolResult;
  assert.equal(toolResult?.toolUseId, "tu-1");
  assert.deepEqual(toolResult?.content?.[0], { text: "22C in Paris" });
  assert.equal(second.system?.[0]?.text, "be brief");
  assert.equal(second.toolConfig?.tools?.[0]?.toolSpec?.name, "get_weather");
});

test("stops after maxSteps", async () => {
  const mcp = fakeMcp([tool("loop")], () => ({ content: [{ type: "text", text: "again" }] }));
  const bedrock = fakeBedrock([toolUse("loop", {})]);
  const agent = new BedrockMcpAgent({ mcp, bedrock, modelId: "m", maxSteps: 3 });
  const res = await agent.run("go");
  assert.equal(res.stopReason, "max_steps");
  assert.equal(res.steps, 3);
  assert.equal(res.toolCalls.length, 3);
});

test("reports thrown tool errors to the model instead of crashing", async () => {
  const mcp = fakeMcp([tool("explode")], () => {
    throw new Error("server down");
  });
  const bedrock = fakeBedrock([toolUse("explode", {}), say("Sorry, that failed.")]);
  const agent = new BedrockMcpAgent({ mcp, bedrock, modelId: "m" });
  const res = await agent.run("try");
  assert.equal(res.toolCalls[0].isError, true);
  assert.deepEqual(bedrock.requests[1].messages?.[2]?.content?.[0]?.toolResult?.content?.[0], { text: "ERROR: server down" });
  assert.equal(res.text, "Sorry, that failed.");
});

test("follows listTools pagination and applies toolFilter", async () => {
  const pages: Record<string, { tools: unknown[]; nextCursor?: string }> = {
    first: { tools: [tool("a"), tool("secret")], nextCursor: "p2" },
    p2: { tools: [tool("b")] },
  };
  const mcp: McpToolSource = {
    listTools: async (params) => pages[params?.cursor ?? "first"] as never,
    callTool: async () => ({}),
  };
  const agent = new BedrockMcpAgent({ mcp, bedrock: fakeBedrock([say("hi")]), modelId: "m", toolFilter: (t) => t.name !== "secret" });
  const tools = await agent.init();
  assert.deepEqual(tools.map((t) => t.name), ["a", "b"]);
});

test("merges into a dangling user message so roles keep alternating", async () => {
  const mcp = fakeMcp([], () => ({}));
  let fail = true;
  const bedrock = {
    send: async () => {
      if (fail) {
        fail = false;
        throw new Error("throttled");
      }
      return say("ok") as unknown as ConverseCommandOutput;
    },
  };
  const agent = new BedrockMcpAgent({ mcp, bedrock, modelId: "m" });
  await assert.rejects(agent.run("first"));
  const res = await agent.run("second");
  assert.equal(res.text, "ok");
  assert.equal(agent.messages[0].role, "user");
  assert.equal(agent.messages[0].content?.length, 2);
  assert.equal(agent.messages[1].role, "assistant");
});

test("omits toolConfig when the server has no tools", async () => {
  const bedrock = fakeBedrock([say("hello")]);
  const agent = new BedrockMcpAgent({ mcp: fakeMcp([], () => ({})), bedrock, modelId: "m" });
  await agent.run("hi");
  assert.equal(bedrock.requests[0].toolConfig, undefined);
});
