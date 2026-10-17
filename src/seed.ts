/** Loads demo pantry data so the video shows expiring food right away. */
import "dotenv/config";
import { addPantryItem, describe, listPantry, resetStore } from "./store.js";

await resetStore();

const items: Array<[name: string, quantity: number, unit: string | undefined, expiresInDays: number | undefined]> = [
  ["spinach", 1, "bag", 1],
  ["chicken thighs", 500, "g", 2],
  ["tomatoes", 3, undefined, 3],
  ["eggs", 6, undefined, 10],
  ["cheddar", 200, "g", 14],
  ["milk", 1, "litre", 4],
  ["rice", 1, "kg", undefined],
  ["pasta", 500, "g", undefined],
  ["onions", 2, undefined, undefined],
  ["garlic", 1, "bulb", undefined],
];

for (const [name, quantity, unit, expiresInDays] of items) {
  await addPantryItem({ name, quantity, unit, expiresInDays });
}

console.log("Seeded pantry:");
for (const i of await listPantry()) console.log(` - ${describe(i)}`);
