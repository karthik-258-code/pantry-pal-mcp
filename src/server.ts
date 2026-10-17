import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./mcp.js";
import { MODEL_ID } from "./bedrock.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, protocolVersion: LATEST_PROTOCOL_VERSION, model: MODEL_ID });
});

// Security required by the Streamable HTTP spec: validate Origin (DNS rebinding) and optionally require a token.
app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    jsonRpcError(res, 403, `Origin not allowed: ${origin}`);
    return;
  }
  if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    jsonRpcError(res, 401, "Unauthorized");
    return;
  }
  next();
});

// Stateless Streamable HTTP: a fresh server + transport per request, shared data store underneath.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
  }
});

// No server-initiated streams or sessions in stateless mode.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  jsonRpcError(res, 405, "Method not allowed");
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, HOST, () => {
  console.log(`Pantry Pal MCP server on http://${HOST}:${PORT}/mcp`);
  console.log(`MCP protocol ${LATEST_PROTOCOL_VERSION} | Bedrock model ${MODEL_ID} | auth ${AUTH_TOKEN ? "on" : "off"}`);
});
