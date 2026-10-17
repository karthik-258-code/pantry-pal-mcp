# mcp-bedrock-bridge

[![test](https://github.com/karthik-258-code/mcp-bedrock-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/karthik-258-code/mcp-bedrock-bridge/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Use **any MCP server's tools** with **Amazon Bedrock's Converse API**, in a few lines of code.

MCP servers describe tools in JSON Schema and return MCP content blocks. Bedrock's Converse API expects `toolSpec`s with strict name rules and its own `toolResult` format. Everyone wiring the two together writes the same glue code and hits the same issues: invalid tool names (`files.read`), `$schema` keys some models reject, images that need byte conversion, errors that models don't support as a `status` field, and conversations that break when roles stop alternating. This library is that glue, with tests.

```ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BedrockMcpAgent } from "mcp-bedrock-bridge";

const mcp = new Client({ name: "my-app", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3000/mcp")));

const agent = new BedrockMcpAgent({
  mcp,
  bedrock: new BedrockRuntimeClient({ region: "us-east-1" }),
  modelId: "us.amazon.nova-lite-v1:0",
  system: "You are a helpful assistant.",
});

const { text, toolCalls } = await agent.run("What's about to expire in my fridge?");
```

## What it does

| Function | Purpose |
|---|---|
| `mcpToolsToBedrock(tools)` | MCP tool list to a Bedrock `toolConfig`. Sanitises names to `^[a-zA-Z0-9_-]{1,64}$`, de-duplicates collisions (`files.read` and `files/read` become `files_read` and `files_read_2`), drops `$schema`, and falls back to `title` or `name` when there's no description. Returns a reverse map to the original MCP names. |
| `mcpResultToToolResult(id, result)` | MCP `CallToolResult` to a Bedrock `toolResult` block. Handles text, base64 images (PNG/JPEG/GIF/WebP to bytes; unsupported types become a note), embedded resources, resource links, `structuredContent` (as a `json` block) and the legacy `toolResult` shape. Errors use an `ERROR:` prefix by default, or Bedrock's `status` field with `includeStatus: true` for models that support it. |
| `BedrockMcpAgent` | A tool-use loop: lists tools (following pagination), calls Converse, runs each requested MCP tool, feeds results back, and stops at the final answer or `maxSteps`. Tool exceptions are reported to the model instead of crashing. A failed run never leaves the history with two user messages in a row. |
| `cleanModelText(text)` | Strips `<thinking>` and `<response>` wrappers that some models (e.g. Amazon Nova) emit. |

### Options

`mcp`, `bedrock`, `modelId` (required), `system` (string or function), `maxSteps` (default 8), `inferenceConfig`, `includeToolStatus`, `toolFilter(tool)`, `onToolCall(record)`.

`mcp` can be the MCP SDK `Client` or any object with `listTools` and `callTool`. `bedrock` can be a `BedrockRuntimeClient` or any object with `send(ConverseCommand)`, which makes it easy to test.

## Install and test

Requires Node.js 20+. Peer dependencies: `@modelcontextprotocol/sdk` ^1.24 and `@aws-sdk/client-bedrock-runtime` ^3.700.

```bash
npm install
npm test          # 14 tests, mocked MCP and Bedrock, no AWS account needed
npm run build
```

Run the example against any Streamable HTTP MCP server (needs AWS credentials with `bedrock:InvokeModel`):

```bash
MCP_URL=http://127.0.0.1:3000/mcp npm run example -- "what tools do you have?"
```

## Origin

Extracted from [Pantry Pal](https://github.com/karthik-258-code/pantry-pal-mcp), an Alexa+ MCP server built for the Amazon Developer hackathon (October 2026). Its simulated Alexa+ assistant uses this exact pattern to let Amazon Nova call 17 MCP tools.

## License

[MIT](LICENSE)
