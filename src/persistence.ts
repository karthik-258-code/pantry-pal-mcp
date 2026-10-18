/**
 * Where household data lives.
 * - file (default): data/pantry.json for the default household, data/<household>.json for others
 * - dynamodb: one item per household in a single-table layout (pk = household#<id>, data = JSON)
 *
 * Select with STORE=file|dynamodb. The store keeps an in-memory copy per household and calls
 * write() after every change, so each backend only needs read/write of a whole document.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HOUSEHOLD } from "./context.js";
import type { StoreData } from "./store.js";

export interface Persistence {
  readonly kind: "file" | "dynamodb";
  read(household: string): Promise<Partial<StoreData> | undefined>;
  write(household: string, data: StoreData): Promise<void>;
}

const safeName = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

class FilePersistence implements Persistence {
  readonly kind = "file" as const;
  constructor(
    private readonly dir: string,
    private readonly defaultFile: string,
  ) {}

  private fileFor(household: string): string {
    return household === DEFAULT_HOUSEHOLD ? this.defaultFile : path.join(this.dir, `${safeName(household)}.json`);
  }

  async read(household: string): Promise<Partial<StoreData> | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.fileFor(household), "utf8")) as Partial<StoreData>;
    } catch {
      return undefined;
    }
  }

  async write(household: string, data: StoreData): Promise<void> {
    const file = this.fileFor(household);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  }
}

class DynamoPersistence implements Persistence {
  readonly kind = "dynamodb" as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    region: string,
  ) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  }

  async read(household: string): Promise<Partial<StoreData> | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `household#${household}` } }));
    const raw = res.Item?.data;
    return typeof raw === "string" ? (JSON.parse(raw) as Partial<StoreData>) : undefined;
  }

  async write(household: string, data: StoreData): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `household#${household}`, data: JSON.stringify(data), updatedAt: new Date().toISOString() },
      }),
    );
  }
}

export function createPersistence(): Persistence {
  if ((process.env.STORE ?? "file").toLowerCase() === "dynamodb") {
    const table = process.env.DYNAMODB_TABLE ?? "pantry-pal";
    const region = process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? "us-east-1";
    return new DynamoPersistence(table, region);
  }
  const defaultFile = path.resolve(process.env.DATA_FILE ?? "data/pantry.json");
  return new FilePersistence(path.dirname(defaultFile), defaultFile);
}

export const persistence: Persistence = createPersistence();
