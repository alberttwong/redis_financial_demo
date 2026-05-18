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
    "acct:",
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
