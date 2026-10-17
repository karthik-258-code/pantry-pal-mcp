/**
 * Connect any Streamable HTTP MCP server to an Amazon Bedrock model and ask one question.
 *
 *   MCP_URL=http://127.0.0.1:3000/mcp npm run example -- "what's about to expire?"
 *
 * AWS credentials come from the default chain (env vars, `aws configure`, AWS_PROFILE).
 */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BedrockMcpAgent } from "../src/index.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const prompt = process.argv.slice(2).join(" ") || "What can you help me with?";

const mcp = new Client({ name: "mcp-bedrock-bridge-example", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(url));

const agent = new BedrockMcpAgent({
  mcp,
  bedrock: new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  modelId: process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0",
  system: "You are a helpful assistant. Use the available tools when they help. Be brief.",
  onToolCall: (c) => console.log(`[tool] ${c.name} ${JSON.stringify(c.input)} (${c.ms} ms)`),
});

const tools = await agent.init();
console.log(`Connected to ${url} with ${tools.length} tools.`);

const res = await agent.run(prompt);
console.log(`\n${res.text}\n\n(${res.toolCalls.length} tool calls, ${res.steps} model calls, stop: ${res.stopReason})`);
await mcp.close();
