import { promises as fs } from "node:fs";
import path from "node:path";

export interface PantryItem {
  name: string;
  quantity: number;
  unit: string;
  addedAt: string;
  expiresAt?: string;
}

export interface ShoppingItem {
  name: string;
  quantity?: number;
  unit?: string;
  reason?: string;
  addedAt: string;
}

export interface StoreData {
  pantry: PantryItem[];
  shopping: ShoppingItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATA_FILE = path.resolve(process.env.DATA_FILE ?? "data/pantry.json");

let cache: StoreData | null = null;
let writeChain: Promise<void> = Promise.resolve();

const norm = (s: string) => s.trim().toLowerCase();

async function load(): Promise<StoreData> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as StoreData;
  } catch {
    cache = { pantry: [], shopping: [] };
  }
  return cache;
}

// Serialise writes so concurrent tool calls never interleave on disk.
function save(): Promise<void> {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(async () => {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, snapshot);
  });
  return writeChain;
}

export function daysLeft(item: PantryItem): number | undefined {
  if (!item.expiresAt) return undefined;
  return Math.ceil((Date.parse(item.expiresAt) - Date.now()) / DAY_MS);
}

/** Voice-friendly description, e.g. "6 eggs (expires in 3 days)". */
export function describe(item: PantryItem): string {
  const amount =
    item.unit === "item" ? `${item.quantity} ${item.name}` : `${item.quantity} ${item.unit} of ${item.name}`;
  const d = daysLeft(item);
  if (d === undefined) return amount;
  if (d < 0) return `${amount} (expired ${-d} day${d === -1 ? "" : "s"} ago)`;
  if (d === 0) return `${amount} (expires today)`;
  return `${amount} (expires in ${d} day${d === 1 ? "" : "s"})`;
}

export async function addPantryItem(input: {
  name: string;
  quantity: number;
  unit?: string;
  expiresInDays?: number;
}): Promise<PantryItem> {
  const data = await load();
  const unit = input.unit?.trim() || "item";
  const expiresAt =
    input.expiresInDays !== undefined ? new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString() : undefined;

  const existing = data.pantry.find((p) => norm(p.name) === norm(input.name) && norm(p.unit) === norm(unit));
  if (existing) {
    existing.quantity += input.quantity;
    // Keep the earliest expiry so we never under-warn.
    if (expiresAt && (!existing.expiresAt || expiresAt < existing.expiresAt)) existing.expiresAt = expiresAt;
    await save();
    return existing;
  }

  const item: PantryItem = {
    name: input.name.trim(),
    quantity: input.quantity,
    unit,
    addedAt: new Date().toISOString(),
    expiresAt,
  };
  data.pantry.push(item);
  await save();
  return item;
}

export async function usePantryItem(
  name: string,
  quantity?: number,
): Promise<{ found: boolean; remaining?: PantryItem; item?: PantryItem }> {
  const data = await load();
  const idx = data.pantry.findIndex((p) => norm(p.name) === norm(name));
  if (idx === -1) return { found: false };
  const item = data.pantry[idx];
  if (quantity === undefined || quantity >= item.quantity) {
    data.pantry.splice(idx, 1);
    await save();
    return { found: true, item };
  }
  item.quantity -= quantity;
  await save();
  return { found: true, remaining: item, item };
}

/** Pantry sorted by soonest expiry first. */
export async function listPantry(expiringWithinDays?: number): Promise<PantryItem[]> {
  const data = await load();
  const items =
    expiringWithinDays === undefined
      ? [...data.pantry]
      : data.pantry.filter((p) => {
          const d = daysLeft(p);
          return d !== undefined && d <= expiringWithinDays;
        });
  return items.sort((a, b) => (daysLeft(a) ?? 9999) - (daysLeft(b) ?? 9999));
}

/** Adds items that aren't already on the list. Returns only the newly added ones. */
export async function addShoppingItems(
  items: Array<{ name: string; quantity?: number; unit?: string; reason?: string }>,
): Promise<ShoppingItem[]> {
  const data = await load();
  const added: ShoppingItem[] = [];
  for (const i of items) {
    if (!i.name.trim() || data.shopping.some((s) => norm(s.name) === norm(i.name))) continue;
    const entry: ShoppingItem = { ...i, name: i.name.trim(), addedAt: new Date().toISOString() };
    data.shopping.push(entry);
    added.push(entry);
  }
  if (added.length) await save();
  return added;
}

export async function getShoppingList(): Promise<ShoppingItem[]> {
  return [...(await load()).shopping];
}

/** Moves bought items (or everything when `names` is empty) from the shopping list into the pantry. */
export async function completeShopping(names?: string[]): Promise<ShoppingItem[]> {
  const data = await load();
  const wanted = names?.length ? new Set(names.map(norm)) : undefined;
  const bought = data.shopping.filter((s) => !wanted || wanted.has(norm(s.name)));
  data.shopping = data.shopping.filter((s) => !bought.includes(s));
  await save();
  for (const b of bought) {
    await addPantryItem({ name: b.name, quantity: b.quantity ?? 1, unit: b.unit });
  }
  return bought;
}

export async function resetStore(data: StoreData = { pantry: [], shopping: [] }): Promise<void> {
  cache = data;
  await save();
}
