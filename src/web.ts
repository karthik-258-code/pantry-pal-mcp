/**
 * Echo Show-style simulated Alexa+ web app.
 * Browser -> /api/chat -> Assistant (Bedrock tool use) -> Pantry Pal MCP server.
 * Spoken replies use Amazon Polly neural voices (browser speech synthesis as a fallback).
 */
import "dotenv/config";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from "@aws-sdk/client-polly";
import { Assistant, connectMcp, MCP_URL } from "./agent.js";
import { MODEL_ID } from "./bedrock.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.WEB_PORT ?? 3001);
const VOICE = (process.env.POLLY_VOICE ?? "Joanna") as VoiceId;
const polly = new PollyClient({ region: process.env.AWS_REGION ?? "us-east-1" });

let mcp: Awaited<ReturnType<typeof connectMcp>>;
try {
  mcp = await connectMcp("pantry-pal-web");
} catch (err) {
  console.error(`Could not reach the MCP server at ${MCP_URL}. Start it first with: npm run dev`);
  console.error((err as Error).message);
  process.exit(1);
}
let assistant = new Assistant(mcp.client, mcp.toolConfig);

// One conversation at a time: queue turns so the message history never interleaves.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const fail = (res: Response, status: number, err: unknown) =>
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.resolve("public")));

app.post("/api/chat", async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    fail(res, 400, "text is required");
    return;
  }
  try {
    res.json(await serial(() => assistant.turn(text)));
  } catch (err) {
    fail(res, 500, err);
  }
});

// Photo upload: call scan_groceries directly (no huge base64 through the model), then let the assistant summarise.
app.post("/api/scan", async (req: Request, res: Response) => {
  const image = String(req.body?.image ?? "");
  const source = ["fridge", "pantry", "receipt"].includes(req.body?.source) ? req.body.source : "fridge";
  if (!image.startsWith("data:image/")) {
    fail(res, 400, "image must be a data:image/... URL");
    return;
  }
  try {
    const result = await serial(async () => {
      const scan = await assistant.callTool("scan_groceries", { image_base64: image, source });
      const turn = await assistant.turn(
        `(I just showed you a photo of my ${source} and you scanned it. Scan result:\n${scan.result}\nTell me in one short sentence what you found.)`,
      );
      return { say: turn.say, calls: [scan, ...turn.calls] };
    });
    res.json(result);
  } catch (err) {
    fail(res, 500, err);
  }
});

app.post("/api/tts", async (req: Request, res: Response) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 2900);
  if (!text) {
    fail(res, 400, "text is required");
    return;
  }
  try {
    const out = await polly.send(
      new SynthesizeSpeechCommand({ Text: text, OutputFormat: "mp3", VoiceId: VOICE, Engine: "neural" }),
    );
    const bytes = await out.AudioStream?.transformToByteArray();
    if (!bytes) throw new Error("Polly returned no audio");
    res.type("audio/mpeg").send(Buffer.from(bytes));
  } catch (err) {
    // The browser falls back to its built-in voice; log why so it's easy to fix.
    console.error(`Amazon Polly failed (voice ${VOICE}): ${(err as Error).message}`);
    fail(res, 502, err);
  }
});

app.post("/api/reset", (_req: Request, res: Response) => {
  assistant = new Assistant(mcp.client, mcp.toolConfig);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`Pantry Pal web app on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(`MCP ${MCP_URL} (${mcp.toolCount} tools) | Bedrock ${MODEL_ID} | Polly voice ${VOICE}`);
});
