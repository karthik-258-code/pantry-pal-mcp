# Pantry Pal: an Alexa+ MCP server for zero-waste cooking

> "Alexa, what can I cook tonight?"
> "You could make a spinach and chicken rice bowl in 25 minutes. It uses the spinach that expires tomorrow."

Pantry Pal is a **self-hosted MCP server** (Streamable HTTP, MCP spec `2025-11-25`) that gives Alexa+, or any MCP client, a memory of your kitchen. It tracks what you have and when it expires, uses **Amazon Bedrock** to suggest recipes that use the soonest-expiring food first, and puts missing ingredients straight on your shopping list.

**Hackathon entry:** Primary track **Alexa+ (MCP server)** · Mini challenge **AWS Builder (Amazon Bedrock)**

## How it works

```
 Alexa+ / MCP Inspector / demo agent
            │  JSON-RPC over Streamable HTTP (POST /mcp)
            ▼
 ┌───────────────────────────┐      ┌──────────────────────────────┐
 │ Pantry Pal MCP server     │─────▶│ Amazon Bedrock (Converse API) │
 │ Express + MCP TS SDK      │      │ recipe generation             │
 │ Origin check + Bearer auth│      └──────────────────────────────┘
 └────────────┬──────────────┘
              ▼
      data/pantry.json (pantry + shopping list)
```

- `src/server.ts`: Express app exposing `POST /mcp` with the SDK's `StreamableHTTPServerTransport` in stateless mode. Validates `Origin` and an optional bearer token.
- `src/mcp.ts`: the 8 MCP tools, with voice-friendly responses.
- `src/bedrock.ts`: Amazon Bedrock Runtime `Converse` call that returns structured recipes.
- `src/store.ts`: JSON-file storage, sorted by expiry.
- `src/demo-agent.ts`: a **simulated Alexa+** terminal assistant. A Bedrock model plans and calls the MCP tools through the MCP client SDK.
- `src/seed.ts`: demo data.

## MCP tools

| Tool | Example utterance |
|---|---|
| `scan_groceries` (Bedrock vision) | "Scan fridge.jpg" / "Here's my grocery receipt" |
| `update_household_profile` | "My son is allergic to peanuts, we're a family of 4" |
| `get_household_profile` | "What do you remember about us?" |
| `rate_recipe` | "The kids loved the frittata" / "That was too spicy" |
| `plan_meals` (Bedrock) | "Plan dinners for the next 5 days" |
| `get_meal_plan` | "What's for dinner tomorrow?" |
| `prepare_grocery_order` | "Order it" (prices the list and asks for confirmation) |
| `confirm_grocery_order` | "Yes, place it" (simulated checkout, no real payment) |
| `receive_grocery_order` | "My groceries arrived" |
| `add_pantry_item` | "I bought 6 eggs that expire in 10 days" |
| `use_pantry_item` | "I used 200 grams of chicken" |
| `list_pantry` | "What's about to go bad?" |
| `suggest_recipes` (Bedrock) | "What can I make for a quick vegetarian dinner?" |
| `add_missing_ingredients` | "Add what I'm missing for the frittata" |
| `add_to_shopping_list` | "Add bread and butter to my list" |
| `get_shopping_list` | "What's on my shopping list?" |
| `mark_shopping_done` | "I bought everything" |

## Quick start

Requirements: Node.js 20+, an AWS account with Amazon Bedrock access.

```bash
npm install
cp .env.example .env          # set AWS_REGION / BEDROCK_MODEL_ID if needed
aws configure                 # or export AWS_PROFILE=...
npm run seed                  # load demo pantry
npm run dev                   # MCP server on http://127.0.0.1:3000/mcp
```

Check it is up with `curl http://127.0.0.1:3000/health`. The response includes the MCP protocol version that the SDK negotiates.

### Try it with MCP Inspector

```bash
npm run inspector
```

Choose **Transport: Streamable HTTP**, URL `http://127.0.0.1:3000/mcp`, click **Connect**, then **Tools > List Tools** and run `suggest_recipes`.

### Try the simulated Alexa+ assistant

With the server running, in a second terminal:

```bash
npm run agent
```

```
You: what's about to expire?
  [MCP] list_pantry {"expiring_within_days":3}
Alexa: Your spinach expires tomorrow, and the chicken thighs and tomatoes within 3 days.
You: what can I cook with those tonight?
  [MCP] suggest_recipes {"meal":"dinner"}
Alexa: ...
```

### Scan a fridge photo or receipt

Put a JPEG or PNG under 3.75 MB in the `photos/` folder, for example `photos/fridge.jpg`, then tell the agent `scan fridge.jpg`. Bedrock vision identifies the food, estimates expiry dates and adds everything to the pantry. For receipts, say `scan receipt.jpg, it's a receipt`.

### Household memory

Allergies, diet, household size, dislikes and recipe ratings are saved in `data/pantry.json` and survive restarts. Every recipe request uses them, and any generated recipe that mentions an allergen is filtered out as a safety net.

### Plan the week and check out

`plan_meals` asks Bedrock for a multi-day plan that cooks the soonest-expiring food first and reuses bought ingredients across days, then adds what's missing to the shopping list. `prepare_grocery_order` prices the list at a simulated store (`src/catalog.ts`) and returns a quote. `confirm_grocery_order` places it only after the user says yes, and quotes expire after 30 minutes. `receive_grocery_order` stocks the pantry on delivery. **No real purchases are made.**

### Expose it to a remote MCP client

The server binds to `127.0.0.1` by default. To reach it from a hosted client, put it behind an HTTPS tunnel or reverse proxy and **set `MCP_AUTH_TOKEN`**. Clients must then send `Authorization: Bearer <token>`.

## AWS integration (AWS Builder)

| Service | Where | What for |
|---|---|---|
| **Amazon Bedrock Runtime, Converse API** | `src/bedrock.ts` `generateRecipes()` | Turns the expiry-sorted pantry plus constraints (meal, servings, diet, time) into structured JSON recipes with used and missing ingredients |
| **Amazon Bedrock Runtime, Converse tool use** | `src/demo-agent.ts` | The simulated Alexa+ assistant: MCP tool schemas are mapped to Bedrock `toolConfig`, and the model decides which MCP tool to call |

The default model is `us.amazon.nova-lite-v1:0` (Amazon Nova Lite through a cross-region inference profile). You can switch to any Converse-compatible model with `BEDROCK_MODEL_ID`. The IAM identity needs `bedrock:InvokeModel` on that model or inference profile, and model access must be enabled in the Bedrock console.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-lite-v1:0` | Converse-compatible model ID |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Bind address |
| `MCP_AUTH_TOKEN` | (unset) | Require `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | (unset) | Comma-separated browser origins allowed on `/mcp` |
| `DATA_FILE` | `data/pantry.json` | Storage location |
| `MCP_URL` | `http://127.0.0.1:3000/mcp` | Server URL used by the demo agent |

## License

[MIT](LICENSE)
