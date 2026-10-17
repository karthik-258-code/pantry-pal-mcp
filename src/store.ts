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

export interface HouseholdProfile {
  people: number;
  diet?: string;
  allergies: string[];
  dislikes: string[];
  notes?: string;
}

export type Rating = "loved" | "liked" | "disliked";

export interface Feedback {
  recipe: string;
  rating: Rating;
  note?: string;
  at: string;
}

export interface PlanDay {
  day: string;
  recipe: string;
  minutes: number;
  uses: string[];
  missing: string[];
}

export interface MealPlan {
  createdAt: string;
  meal: string;
  days: PlanDay[];
}

export interface OrderLine {
  name: string;
  packs: number;
  unitPrice: number;
  lineTotal: number;
}

export type OrderStatus = "pending" | "placed" | "delivered";

export interface Order {
  id: string;
  store: string;
  lines: OrderLine[];
  subtotal: number;
  deliveryFee: number;
  total: number;
  status: OrderStatus;
  createdAt: string;
  placedAt?: string;
  deliveredAt?: string;
}

export interface StoreData {
  pantry: PantryItem[];
  shopping: ShoppingItem[];
  profile: HouseholdProfile;
  feedback: Feedback[];
  mealPlan?: MealPlan;
  orders: Order[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FEEDBACK = 50;
const DATA_FILE = path.resolve(process.env.DATA_FILE ?? "data/pantry.json");

export const emptyData = (): StoreData => ({
  pantry: [],
  shopping: [],
  profile: { people: 2, allergies: [], dislikes: [] },
  feedback: [],
  orders: [],
});

let cache: StoreData | null = null;
let writeChain: Promise<void> = Promise.resolve();

const norm = (s: string) => s.trim().toLowerCase();

async function load(): Promise<StoreData> {
  if (cache) return cache;
  const base = emptyData();
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as Partial<StoreData>;
    // Older data files have no profile/feedback; fill in defaults.
    cache = { ...base, ...parsed, profile: { ...base.profile, ...parsed.profile } };
  } catch {
    cache = base;
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

// ---------- Household memory ----------

function mergeList(list: string[], add: string[] = [], remove: string[] = []): string[] {
  const removeSet = new Set(remove.map(norm));
  const out = list.filter((x) => !removeSet.has(norm(x)));
  for (const a of add) {
    if (a.trim() && !out.some((x) => norm(x) === norm(a))) out.push(a.trim());
  }
  return out;
}

export async function getProfile(): Promise<HouseholdProfile> {
  return structuredClone((await load()).profile);
}

export async function updateProfile(u: {
  people?: number;
  diet?: string;
  notes?: string;
  addAllergies?: string[];
  removeAllergies?: string[];
  addDislikes?: string[];
  removeDislikes?: string[];
}): Promise<HouseholdProfile> {
  const data = await load();
  const p = data.profile;
  if (u.people !== undefined) p.people = u.people;
  if (u.diet !== undefined) p.diet = u.diet.trim() || undefined;
  if (u.notes !== undefined) p.notes = u.notes.trim() || undefined;
  p.allergies = mergeList(p.allergies, u.addAllergies, u.removeAllergies);
  p.dislikes = mergeList(p.dislikes, u.addDislikes, u.removeDislikes);
  await save();
  return structuredClone(p);
}

export function describeProfile(p: HouseholdProfile): string {
  return [
    `${p.people} ${p.people === 1 ? "person" : "people"}`,
    p.diet && `diet: ${p.diet}`,
    p.allergies.length ? `allergies: ${p.allergies.join(", ")}` : "no allergies",
    p.dislikes.length && `dislikes: ${p.dislikes.join(", ")}`,
    p.notes && `notes: ${p.notes}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export async function addFeedback(recipe: string, rating: Rating, note?: string): Promise<void> {
  const data = await load();
  data.feedback.push({ recipe: recipe.trim(), rating, note: note?.trim() || undefined, at: new Date().toISOString() });
  data.feedback = data.feedback.slice(-MAX_FEEDBACK);
  await save();
}

export async function recentFeedback(limit = 10): Promise<Feedback[]> {
  return (await load()).feedback.slice(-limit);
}

// ---------- Meal plan ----------

export async function saveMealPlan(plan: MealPlan): Promise<void> {
  (await load()).mealPlan = plan;
  await save();
}

export async function getMealPlan(): Promise<MealPlan | undefined> {
  const plan = (await load()).mealPlan;
  return plan ? structuredClone(plan) : undefined;
}

// ---------- Orders (simulated checkout) ----------

const ORDER_TTL_MS = 30 * 60 * 1000;

export async function createOrder(order: Omit<Order, "id" | "status" | "createdAt">): Promise<Order> {
  const data = await load();
  // Only one pending quote at a time: a new quote replaces the old one.
  data.orders = data.orders.filter((o) => o.status !== "pending");
  const full: Order = {
    ...order,
    id: `PP-${Math.floor(1000 + Math.random() * 9000)}`,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  data.orders.push(full);
  await save();
  return structuredClone(full);
}

export async function getPendingOrder(): Promise<Order | undefined> {
  const o = (await load()).orders.find((x) => x.status === "pending");
  return o ? structuredClone(o) : undefined;
}

/** Places a pending order and removes its items from the shopping list. */
export async function placeOrder(id: string): Promise<{ order?: Order; error?: string }> {
  const data = await load();
  const order = data.orders.find((o) => o.id.toLowerCase() === id.trim().toLowerCase());
  if (!order) return { error: `I can't find order ${id}.` };
  if (order.status !== "pending") return { error: `Order ${order.id} is already ${order.status}.` };
  if (Date.now() - Date.parse(order.createdAt) > ORDER_TTL_MS) {
    return { error: `The quote for ${order.id} expired. Ask me to prepare a new order.` };
  }
  order.status = "placed";
  order.placedAt = new Date().toISOString();
  const names = new Set(order.lines.map((l) => norm(l.name)));
  data.shopping = data.shopping.filter((s) => !names.has(norm(s.name)));
  await save();
  return { order: structuredClone(order) };
}

/** Marks the latest placed order (or a specific one) delivered and stocks the pantry. */
export async function receiveOrder(id?: string): Promise<{ order?: Order; error?: string }> {
  const data = await load();
  const placed = data.orders.filter((o) => o.status === "placed");
  const order = id ? placed.find((o) => o.id.toLowerCase() === id.trim().toLowerCase()) : placed[placed.length - 1];
  if (!order) return { error: "There's no order waiting for delivery." };
  order.status = "delivered";
  order.deliveredAt = new Date().toISOString();
  await save();
  for (const l of order.lines) await addPantryItem({ name: l.name, quantity: l.packs });
  return { order: structuredClone(order) };
}

export async function resetStore(data: StoreData = emptyData()): Promise<void> {
  cache = data;
  await save();
}
