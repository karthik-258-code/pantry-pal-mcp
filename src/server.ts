import "dotenv/config";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { authMode, createApp } from "./app.js";
import { MODEL_ID } from "./bedrock.js";
import { persistence } from "./persistence.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);

createApp().listen(PORT, HOST, () => {
  console.log(`Pantry Pal MCP server on http://${HOST}:${PORT}/mcp`);
  console.log(`MCP protocol ${LATEST_PROTOCOL_VERSION} | Bedrock ${MODEL_ID} | store ${persistence.kind} | auth ${authMode()}`);
});
