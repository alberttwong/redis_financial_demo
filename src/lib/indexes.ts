import type { RedisClientType } from "redis";

export const INDEXES = {
  accounts: "idx:accounts",
  securities: "idx:securities",
  positions: "idx:positions",
  transactions: "idx:transactions",
  snapshots: "idx:account_snapshots"
} as const;

const INDEX_COMMANDS: string[][] = [
  [
    "FT.CREATE",
    INDEXES.accounts,
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "acct:",
    "SCHEMA",
    "$.account_id",
    "AS",
    "account_id",
    "TAG"
  ],
  [
    "FT.CREATE",
    INDEXES.securities,
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "sec:",
    "SCHEMA",
    "$.security_id",
    "AS",
    "security_id",
    "TAG",
    "$.security_no",
    "AS",
    "security_no",
    "TAG"
  ],
  [
    "FT.CREATE",
    INDEXES.positions,
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "pos:",
    "SCHEMA",
    "$._id",
    "AS",
    "_id",
    "TAG",
    "$.account_id",
    "AS",
    "account_id",
    "TAG",
    "$.security_no",
    "AS",
    "security_no",
    "TAG",
    "$.acct_type_code",
    "AS",
    "acct_type_code",
    "TAG"
  ],
  [
    "FT.CREATE",
    INDEXES.transactions,
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "txn:",
    "SCHEMA",
    "$._id",
    "AS",
    "_id",
    "TAG",
    "$.account_id",
    "AS",
    "account_id",
    "TAG",
    "$.security_id",
    "AS",
    "security_id",
    "TAG",
    "$.trade_date_epoch",
    "AS",
    "trade_date_epoch",
    "NUMERIC",
    "SORTABLE",
    "$.acct_type_code",
    "AS",
    "acct_type_code",
    "TAG"
  ],
  [
    "FT.CREATE",
    INDEXES.snapshots,
    "ON",
    "JSON",
    "PREFIX",
    "1",
    "acct-snapshot:",
    "SCHEMA",
    "$.account_id",
    "AS",
    "account_id",
    "TAG",
    "$.position_count",
    "AS",
    "position_count",
    "NUMERIC",
    "$.transaction_count",
    "AS",
    "transaction_count",
    "NUMERIC"
  ]
];

export async function createIndexes(client: RedisClientType): Promise<string[]> {
  const results: string[] = [];
  for (const command of INDEX_COMMANDS) {
    try {
      await client.sendCommand(command);
      results.push(`${command[1]}: created`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Index already exists")) {
        const expectedPrefix = commandPrefix(command);
        const currentPrefixes = await indexPrefixes(client, command[1]);
        if (expectedPrefix && currentPrefixes.length > 0 && !currentPrefixes.includes(expectedPrefix)) {
          await client.sendCommand(["FT.DROPINDEX", command[1]]);
          await client.sendCommand(command);
          results.push(`${command[1]}: recreated with prefix ${expectedPrefix}`);
          continue;
        }

        results.push(`${command[1]}: already exists`);
        continue;
      }
      throw error;
    }
  }
  return results;
}

export async function dropIndexes(client: RedisClientType): Promise<string[]> {
  const results: string[] = [];
  for (const indexName of Object.values(INDEXES)) {
    try {
      await client.sendCommand(["FT.DROPINDEX", indexName]);
      results.push(`${indexName}: dropped`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("Unknown Index name")) {
        results.push(`${indexName}: missing`);
        continue;
      }
      throw error;
    }
  }
  return results;
}

export function indexCommandShapes(): string[] {
  return INDEX_COMMANDS.map((command) => command.join(" "));
}

function commandPrefix(command: string[]): string | null {
  const prefixIndex = command.indexOf("PREFIX");
  if (prefixIndex === -1) return null;
  const prefixCount = Number(command[prefixIndex + 1]);
  if (!Number.isFinite(prefixCount) || prefixCount < 1) return null;
  return command[prefixIndex + 2] ?? null;
}

async function indexPrefixes(client: RedisClientType, indexName: string): Promise<string[]> {
  const info = await client.sendCommand(["FT.INFO", indexName]);
  const indexDefinition = alternatingValue(info, "index_definition");
  return extractPrefixes(indexDefinition) ?? extractPrefixes(info) ?? [];
}

function alternatingValue(value: unknown, key: string): unknown {
  if (!Array.isArray(value)) return null;
  for (let index = 0; index < value.length - 1; index += 2) {
    if (value[index] === key) return value[index + 1];
  }
  return null;
}

function extractPrefixes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== "prefixes") continue;
    const prefixes = stringValues(value[index + 1]);
    if (prefixes.length > 0) return prefixes;
  }

  for (const item of value) {
    const prefixes = extractPrefixes(item);
    if (prefixes && prefixes.length > 0) return prefixes;
  }

  return null;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => stringValues(item));
}
