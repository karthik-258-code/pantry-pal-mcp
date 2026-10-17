/**
 * Simulated grocery store used for the checkout demo. No real purchases are made.
 * Prices are illustrative USD estimates per typical pack.
 */
export const STORE_NAME = "Demo Grocer (simulated)";
export const DELIVERY_FEE = 3.99;
const DEFAULT_PRICE = 2.99;

const PRICES: Record<string, number> = {
  eggs: 3.49, milk: 2.99, butter: 4.29, cheese: 4.49, cheddar: 4.49, parmesan: 5.99,
  mozzarella: 4.29, yogurt: 3.99, cream: 3.29, bread: 3.49, tortillas: 3.29, rice: 3.99,
  pasta: 1.99, noodles: 2.49, flour: 3.49, chicken: 7.99, beef: 8.99, pork: 6.99,
  salmon: 10.99, tofu: 2.99, beans: 1.49, chickpeas: 1.49, lentils: 2.29, spinach: 2.49,
  lettuce: 2.29, tomato: 0.79, onion: 0.69, garlic: 0.79, ginger: 1.29, potato: 0.59,
  carrot: 0.39, pepper: 1.29, broccoli: 2.49, mushroom: 2.99, zucchini: 1.29, cucumber: 0.99,
  lemon: 0.69, lime: 0.49, avocado: 1.49, banana: 0.29, apple: 0.89, basil: 2.49,
  cilantro: 1.29, "soy sauce": 3.49, "coconut milk": 2.49, "tomato sauce": 1.99,
  stock: 2.99, broth: 2.99, curry: 3.99,
};

const singular = (s: string) => s.replace(/(es|s)$/, "");

/** Best-effort price for an ingredient name, e.g. "fresh ginger" -> ginger. */
export function priceFor(name: string): number {
  const n = name.trim().toLowerCase();
  if (PRICES[n] !== undefined) return PRICES[n];
  const s = singular(n);
  // Prefer the longest matching catalog key ("soy sauce" over "sauce").
  const match = Object.keys(PRICES)
    .filter((k) => n.includes(k) || s.includes(singular(k)))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match] : DEFAULT_PRICE;
}

/** How many packs to order. Weights/volumes ("500 g") count as one pack. */
export function packsFor(quantity: number | undefined, unit: string | undefined): number {
  if (!quantity || (unit && unit !== "item")) return 1;
  return Math.min(Math.max(Math.round(quantity), 1), 12);
}

export const money = (n: number) => `$${n.toFixed(2)}`;
