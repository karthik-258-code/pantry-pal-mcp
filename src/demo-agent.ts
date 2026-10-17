/**
 * Simulated Alexa+ experience in the terminal.
 * An Amazon Bedrock model acts as the assistant and calls Pantry Pal tools over MCP (Streamable HTTP).
 */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Assistant, connectMcp, MCP_URL } from "./agent.js";
import { MODEL_ID } from "./bedrock.js";

const { client, toolConfig, toolCount } = await connectMcp("pantry-pal-demo-agent");
console.log(`Connected to ${MCP_URL} (${toolCount} tools). Model: ${MODEL_ID}. Type 'exit' to quit.`);

const assistant = new Assistant(client, toolConfig);
const rl = readline.createInterface({ input: stdin, output: stdout });

while (true) {
  const userText = (await rl.question("\nYou: ")).trim();
  if (!userText || ["exit", "quit"].includes(userText.toLowerCase())) break;
  try {
    const { say } = await assistant.turn(userText, (c) =>
      console.log(`  [MCP] ${c.name} ${JSON.stringify(c.input)}${c.isError ? " (error)" : ""}`),
    );
    console.log(`\nAlexa: ${say}`);
  } catch (err) {
    console.error(`\n(error) ${(err as Error).message}`);
  }
}

rl.close();
await client.close();
