/**
 * Simulated Alexa+ experience in the terminal.
 * An Amazon Bedrock model acts as the assistant and calls Pantry Pal tools over MCP (Streamable HTTP).
 */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { bedrock, MODEL_ID } from "./bedrock.js";

const MCP_URL = new URL(process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp");
const token = process.env.MCP_AUTH_TOKEN?.trim();

const SYSTEM = `You are a friendly voice assistant in the style of Alexa+. Today is ${new Date().toDateString()}.
Use the Pantry Pal tools for anything about food, the pantry, recipes or shopping.
Answer in 1-2 short spoken sentences. Never read out long lists unless asked.
Do not narrate your reasoning; reply only with what Alexa would say out loud.
Photos live in the server's photos folder: pass just the file name (e.g. "fridge.jpg") to scan_groceries.`;

const client = new Client({ name: "pantry-pal-demo-agent", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  }),
);

const { tools } = await client.listTools();
const toolConfig = {
  tools: tools.map((t) => ({
    toolSpec: { name: t.name, description: t.description ?? t.name, inputSchema: { json: t.inputSchema } },
  })) as unknown as Tool[],
};

console.log(`Connected to ${MCP_URL} (${tools.length} tools). Model: ${MODEL_ID}. Type 'exit' to quit.`);

const rl = readline.createInterface({ input: stdin, output: stdout });
const messages: Message[] = [];

while (true) {
  const userText = (await rl.question("\nYou: ")).trim();
  if (!userText || ["exit", "quit"].includes(userText.toLowerCase())) break;
  messages.push({ role: "user", content: [{ text: userText }] });

  for (let step = 0; step < 8; step++) {
    const res = await bedrock().send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM }],
        messages,
        toolConfig,
        inferenceConfig: { maxTokens: 800, temperature: 0.3 },
      }),
    );
    const msg = res.output?.message;
    if (!msg) break;
    messages.push(msg);

    const toolUses = (msg.content ?? []).flatMap((c) => (c.toolUse ? [c.toolUse] : []));
    if (res.stopReason !== "tool_use" || toolUses.length === 0) {
      const say = (msg.content ?? [])
        .map((c) => c.text ?? "")
        .join("")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
        .replace(/<\/?response>/gi, "")
        .trim();
      console.log(`\nAlexa: ${say}`);
      break;
    }

    const results: ContentBlock[] = [];
    for (const use of toolUses) {
      console.log(`  [MCP] ${use.name} ${JSON.stringify(use.input)}`);
      const result = await client.callTool({ name: use.name!, arguments: (use.input ?? {}) as Record<string, unknown> });
      const text = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      results.push({ toolResult: { toolUseId: use.toolUseId!, content: [{ text: result.isError ? `ERROR: ${text}` : text }] } });
    }
    messages.push({ role: "user", content: results });
  }
}

rl.close();
await client.close();
