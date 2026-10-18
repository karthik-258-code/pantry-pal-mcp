/**
 * Which household the current request belongs to.
 * Set per HTTP request in server.ts (from the bearer key) and read by the store, so tool code never
 * needs to pass a household id around. Falls back to "default" for local single-user use and tests.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_HOUSEHOLD = "default";

const storage = new AsyncLocalStorage<string>();

export const currentHousehold = (): string => storage.getStore() ?? DEFAULT_HOUSEHOLD;

export const runWithHousehold = <T>(household: string, fn: () => Promise<T>): Promise<T> => storage.run(household, fn);
