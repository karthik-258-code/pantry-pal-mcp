import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateRecipes, MODEL_ID, type Recipe } from "./bedrock.js";
import * as store from "./store.js";

const INSTRUCTIONS = `Pantry Pal remembers the user's kitchen pantry and shopping list and suggests recipes
that use food before it expires. Keep spoken replies to 1-2 short sentences.
When the user asks what to cook, call suggest_recipes. When they want ingredients for a suggested
recipe, call add_missing_ingredients. When they say they bought groceries, call mark_shopping_done.`;

// Shared across stateless requests so a follow-up like "add what I'm missing for the frittata" works.
let lastRecipes: Recipe[] = [];

function reply(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function findRecipe(query: string): Recipe | undefined {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "one"].includes(w));
  let best: Recipe | undefined;
  let bestScore = 0;
  for (const r of lastRecipes) {
    const name = r.name.toLowerCase();
    const score = words.filter((w) => name.includes(w)).length;
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "pantry-pal", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "add_pantry_item",
    {
      title: "Add pantry item",
      description: "Add food to the pantry, e.g. 'I bought 6 eggs that expire in 10 days'.",
      inputSchema: {
        name: z.string().min(1).describe("Food name, e.g. 'eggs'"),
        quantity: z.number().positive().default(1).describe("Amount"),
        unit: z.string().optional().describe("Unit such as 'g', 'bag', 'bottle'. Omit for countable items."),
        expires_in_days: z.number().int().min(0).optional().describe("Days until it expires"),
      },
    },
    async ({ name, quantity, unit, expires_in_days }) => {
      const item = await store.addPantryItem({ name, quantity, unit, expiresInDays: expires_in_days });
      return reply(`Added. You now have ${store.describe(item)}.`);
    },
  );

  server.registerTool(
    "use_pantry_item",
    {
      title: "Use or remove pantry item",
      description: "Record that food was used, eaten or thrown away. Omit quantity to remove it entirely.",
      inputSchema: {
        name: z.string().min(1).describe("Food name"),
        quantity: z.number().positive().optional().describe("Amount used"),
      },
    },
    async ({ name, quantity }) => {
      const res = await store.usePantryItem(name, quantity);
      if (!res.found) return reply(`I couldn't find ${name} in your pantry.`, true);
      return reply(res.remaining ? `Done. ${store.describe(res.remaining)} left.` : `Done. ${name} is gone from your pantry.`);
    },
  );

  server.registerTool(
    "list_pantry",
    {
      title: "List pantry",
      description: "List what's in the pantry, soonest expiry first. Use expiring_within_days for 'what's about to go bad?'.",
      inputSchema: {
        expiring_within_days: z.number().int().min(0).optional().describe("Only items expiring within this many days"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ expiring_within_days }) => {
      const items = await store.listPantry(expiring_within_days);
      if (!items.length) {
        return reply(expiring_within_days !== undefined ? "Nothing is about to expire." : "Your pantry is empty.");
      }
      return reply(`You have ${items.length} item${items.length === 1 ? "" : "s"}:\n${items.map((i) => `- ${store.describe(i)}`).join("\n")}`);
    },
  );

  server.registerTool(
    "suggest_recipes",
    {
      title: "Suggest recipes",
      description:
        "Use Amazon Bedrock to suggest recipes from the pantry, prioritising food that expires soonest. Use for 'what can I cook?'.",
      inputSchema: {
        meal: z.string().optional().describe("e.g. 'breakfast', 'quick dinner'"),
        servings: z.number().int().min(1).max(12).default(2),
        dietary: z.string().optional().describe("e.g. 'vegetarian', 'no nuts'"),
        max_minutes: z.number().int().positive().optional().describe("Maximum cooking time"),
        count: z.number().int().min(1).max(3).default(2).describe("How many recipes"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ meal, servings, dietary, max_minutes, count }) => {
      const pantry = await store.listPantry();
      if (!pantry.length) return reply("Your pantry is empty. Add a few items first, like 'add 6 eggs'.");
      try {
        const recipes = await generateRecipes({ pantry, meal, servings, dietary, maxMinutes: max_minutes, count });
        if (!recipes.length) return reply("I couldn't come up with a recipe. Try relaxing the constraints.", true);
        lastRecipes = recipes;
        const spoken = recipes.map((r) => `${r.name} in ${r.minutes} minutes`).join(", or ");
        const details = recipes
          .map((r, i) =>
            [
              `${i + 1}. ${r.name} (${r.minutes} min, serves ${r.servings})`,
              `   Uses: ${r.uses.join(", ") || "n/a"}`,
              `   Missing: ${r.missing.join(", ") || "nothing"}`,
              ...r.steps.map((s, j) => `   ${j + 1}) ${s}`),
            ].join("\n"),
          )
          .join("\n\n");
        return reply(`You could make ${spoken}.\n\n${details}\n\n(Generated by Amazon Bedrock, model ${MODEL_ID})`);
      } catch (err) {
        return reply(
          `Recipe generation failed: ${(err as Error).message}. Check AWS credentials and Bedrock model access for ${MODEL_ID}.`,
          true,
        );
      }
    },
  );

  server.registerTool(
    "add_missing_ingredients",
    {
      title: "Add missing ingredients",
      description: "Add the missing ingredients of a recipe from the last suggest_recipes call to the shopping list.",
      inputSchema: {
        recipe_name: z.string().min(1).describe("Recipe name or part of it, e.g. 'frittata'"),
      },
    },
    async ({ recipe_name }) => {
      if (!lastRecipes.length) return reply("Ask me for recipe ideas first.", true);
      const recipe = findRecipe(recipe_name);
      if (!recipe) {
        return reply(`I don't see "${recipe_name}" in the last suggestions: ${lastRecipes.map((r) => r.name).join(", ")}.`, true);
      }
      if (!recipe.missing.length) return reply(`You already have everything for ${recipe.name}.`);
      const added = await store.addShoppingItems(recipe.missing.map((name) => ({ name, reason: recipe.name })));
      return reply(
        added.length
          ? `Added ${added.map((i) => i.name).join(", ")} to your shopping list for ${recipe.name}.`
          : `Everything for ${recipe.name} is already on your shopping list.`,
      );
    },
  );

  server.registerTool(
    "add_to_shopping_list",
    {
      title: "Add to shopping list",
      description: "Add one or more items to the shopping list.",
      inputSchema: {
        items: z
          .array(
            z.object({
              name: z.string().min(1),
              quantity: z.number().positive().optional(),
              unit: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ items }) => {
      const added = await store.addShoppingItems(items);
      return reply(added.length ? `Added ${added.map((i) => i.name).join(", ")}.` : "Those are already on your list.");
    },
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get shopping list",
      description: "Read the shopping list.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const list = await store.getShoppingList();
      if (!list.length) return reply("Your shopping list is empty.");
      const lines = list.map((i) => {
        const amount = i.quantity ? `${i.quantity}${i.unit ? ` ${i.unit}` : ""} ` : "";
        return `- ${amount}${i.name}${i.reason ? ` (for ${i.reason})` : ""}`;
      });
      return reply(`${list.length} item${list.length === 1 ? "" : "s"} on your list:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "mark_shopping_done",
    {
      title: "Mark shopping done",
      description: "Move bought items from the shopping list into the pantry. Omit items to move everything.",
      inputSchema: {
        items: z.array(z.string().min(1)).optional().describe("Names of the items bought"),
      },
    },
    async ({ items }) => {
      const bought = await store.completeShopping(items);
      return reply(
        bought.length
          ? `Nice. I moved ${bought.map((b) => b.name).join(", ")} into your pantry.`
          : "I didn't find those on your shopping list.",
      );
    },
  );

  return server;
}
