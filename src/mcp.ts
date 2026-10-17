import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateRecipes, MODEL_ID, scanGroceries, type ImageFormat, type Recipe } from "./bedrock.js";
import * as store from "./store.js";

const SCAN_DIR = path.resolve(process.env.SCAN_DIR ?? "photos");
// Bedrock Converse image size limit.
const MAX_IMAGE_BYTES = 3_750_000;

const INSTRUCTIONS = `Pantry Pal remembers the household's pantry, shopping list, allergies, dislikes and recipe feedback,
and suggests recipes that use food before it expires. Keep spoken replies to 1-2 short sentences.
- "What can I cook?" -> suggest_recipes (it already applies the household profile and past feedback).
- A photo of a fridge, shelf or receipt -> scan_groceries.
- "We loved/hated that" -> rate_recipe.
- Allergies, diet, family size, dislikes -> update_household_profile.
- Ingredients for a suggested recipe -> add_missing_ingredients. Bought groceries -> mark_shopping_done.`;

function detectFormat(b: Uint8Array): ImageFormat | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  return undefined;
}

async function loadImage(imagePath?: string, imageBase64?: string): Promise<Uint8Array> {
  if (imageBase64) {
    return new Uint8Array(Buffer.from(imageBase64.replace(/^data:[^;]+;base64,/, ""), "base64"));
  }
  if (imagePath) {
    // Only read from the photos folder so a tool call can never read arbitrary files.
    const full = path.resolve(SCAN_DIR, imagePath);
    if (!full.startsWith(SCAN_DIR + path.sep)) throw new Error(`Photos must be inside the ${SCAN_DIR} folder`);
    return new Uint8Array(await fs.readFile(full));
  }
  throw new Error("Provide image_path or image_base64");
}

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
  const server = new McpServer({ name: "pantry-pal", version: "1.1.0" }, { instructions: INSTRUCTIONS });

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
    "scan_groceries",
    {
      title: "Scan groceries from a photo",
      description:
        "Use Amazon Bedrock vision to identify food in a photo of a fridge, pantry shelf or grocery receipt, estimate expiry dates and add the items to the pantry. Pass image_path (a file name inside the server's photos folder) or image_base64.",
      inputSchema: {
        image_path: z.string().optional().describe("File name inside the photos folder, e.g. 'fridge.jpg'"),
        image_base64: z.string().optional().describe("Base64-encoded JPEG/PNG/WebP/GIF, optionally as a data: URL"),
        source: z.enum(["fridge", "pantry", "receipt"]).default("fridge").describe("What the photo shows"),
        add_to_pantry: z.boolean().default(true).describe("Add the detected items to the pantry"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ image_path, image_base64, source, add_to_pantry }) => {
      try {
        const bytes = await loadImage(image_path, image_base64);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return reply("That photo is larger than 3.75 MB. Please use a smaller photo or a screenshot.", true);
        }
        const format = detectFormat(bytes);
        if (!format) return reply("Unsupported image. Use JPEG, PNG, WebP or GIF (iPhone HEIC photos are not supported).", true);

        const items = await scanGroceries(bytes, format, source);
        if (!items.length) return reply("I couldn't spot any food in that photo.");

        const lines: string[] = [];
        for (const i of items) {
          if (add_to_pantry) {
            lines.push(`- ${store.describe(await store.addPantryItem(i))}`);
          } else {
            const unit = i.unit ? ` ${i.unit} of` : "";
            const exp = i.expiresInDays !== undefined ? ` (about ${i.expiresInDays} days)` : "";
            lines.push(`- ${i.quantity}${unit} ${i.name}${exp}`);
          }
        }
        return reply(
          `I ${add_to_pantry ? "added" : "found"} ${items.length} item${items.length === 1 ? "" : "s"} from your ${source} photo:\n${lines.join("\n")}\n\n(Recognised by Amazon Bedrock, model ${MODEL_ID})`,
        );
      } catch (err) {
        return reply(`Scanning failed: ${(err as Error).message}`, true);
      }
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
        "Use Amazon Bedrock to suggest recipes from the pantry, prioritising food that expires soonest and applying the household's allergies, dislikes and past feedback. Use for 'what can I cook?'.",
      inputSchema: {
        meal: z.string().optional().describe("e.g. 'breakfast', 'quick dinner'"),
        servings: z.number().int().min(1).max(12).optional().describe("Defaults to the household size"),
        dietary: z.string().optional().describe("Extra requirement for this meal only, e.g. 'vegetarian'"),
        max_minutes: z.number().int().positive().optional().describe("Maximum cooking time"),
        count: z.number().int().min(1).max(3).default(2).describe("How many recipes"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ meal, servings, dietary, max_minutes, count }) => {
      const pantry = await store.listPantry();
      if (!pantry.length) return reply("Your pantry is empty. Add a few items or scan a photo of your fridge first.");
      try {
        const [profile, feedback] = await Promise.all([store.getProfile(), store.recentFeedback()]);
        const recipes = await generateRecipes({
          pantry,
          profile,
          feedback,
          servings: servings ?? profile.people,
          count,
          meal,
          dietary,
          maxMinutes: max_minutes,
        });
        if (!recipes.length) return reply("I couldn't come up with a safe recipe. Try relaxing the constraints.", true);
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
        return reply(
          `You could make ${spoken}.\n\n${details}\n\nHousehold: ${store.describeProfile(profile)}.\n(Generated by Amazon Bedrock, model ${MODEL_ID})`,
        );
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
    "rate_recipe",
    {
      title: "Rate a recipe",
      description:
        "Remember how the household felt about a recipe, e.g. 'the kids loved the frittata' or 'too spicy'. Future suggestions learn from this.",
      inputSchema: {
        recipe_name: z.string().min(1).describe("Recipe name, or part of it"),
        rating: z.enum(["loved", "liked", "disliked"]),
        note: z.string().optional().describe("Why, e.g. 'too spicy', 'kids asked for seconds'"),
      },
    },
    async ({ recipe_name, rating, note }) => {
      const name = findRecipe(recipe_name)?.name ?? recipe_name;
      await store.addFeedback(name, rating, note);
      return reply(`Got it, I'll remember you ${rating} ${name}${note ? ` (${note})` : ""}.`);
    },
  );

  server.registerTool(
    "get_household_profile",
    {
      title: "Get household profile",
      description: "Read the remembered household size, diet, allergies, dislikes and recent recipe feedback.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [profile, feedback] = await Promise.all([store.getProfile(), store.recentFeedback(5)]);
      const fb = feedback.length
        ? `\nRecent feedback:\n${feedback.map((f) => `- ${f.rating} ${f.recipe}${f.note ? ` (${f.note})` : ""}`).join("\n")}`
        : "";
      return reply(`Household: ${store.describeProfile(profile)}.${fb}`);
    },
  );

  server.registerTool(
    "update_household_profile",
    {
      title: "Update household profile",
      description:
        "Remember household facts across sessions: number of people, diet, allergies and dislikes. Use add_/remove_ lists for changes, e.g. 'my son is allergic to peanuts'.",
      inputSchema: {
        people: z.number().int().min(1).max(20).optional(),
        diet: z.string().optional().describe("e.g. 'vegetarian', 'halal'. Empty string clears it."),
        add_allergies: z.array(z.string().min(1)).optional(),
        remove_allergies: z.array(z.string().min(1)).optional(),
        add_dislikes: z.array(z.string().min(1)).optional(),
        remove_dislikes: z.array(z.string().min(1)).optional(),
        notes: z.string().optional().describe("Free-form, e.g. 'kids prefer mild food'"),
      },
    },
    async (u) => {
      const profile = await store.updateProfile({
        people: u.people,
        diet: u.diet,
        notes: u.notes,
        addAllergies: u.add_allergies,
        removeAllergies: u.remove_allergies,
        addDislikes: u.add_dislikes,
        removeDislikes: u.remove_dislikes,
      });
      return reply(`Saved. Household: ${store.describeProfile(profile)}.`);
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
