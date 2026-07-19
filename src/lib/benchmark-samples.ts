import type { RedisClientType } from "redis";
import { INDEXES } from "./indexes";
import { searchKeys, searchProjected } from "./search";

export const QUERY_PATTERNS = [
  "accountById",
  "securityById",
  "securityByNo",
  "positionByComposite",
  "positionsByAccount",
  "transactionById",
  "transactionsByComposite",
  "transactionsByAccount",
  "transactionsBySecurity",
  "transactionsByAccountSecurity",
  "accountPortfolioJoin",
  "accountActivityJoin",
  "accountSnapshot"
] as const;

export type QueryPattern = (typeof QUERY_PATTERNS)[number];

export type SecuritySample = {
  security_id: string;
  security_no: string;
};

export type PositionSample = SecuritySample & {
  account_id: string;
  acct_type_code: string;
};

export type TransactionSample = PositionSample & {
  trade_date: string;
  transaction_id: string;
};

export type QuerySample = TransactionSample;

export type BenchmarkSamplePool = {
  accounts: string[];
  securities: SecuritySample[];
  positions: PositionSample[];
  transactions: TransactionSample[];
};

const SECURITY_SAMPLE_FIELDS = ["security_id", "security_no"] as const;
const POSITION_SAMPLE_FIELDS = ["account_id", "security_id", "security_no", "acct_type_code"] as const;
const TRANSACTION_SAMPLE_FIELDS = [
  "account_id",
  "security_id",
  "security_no",
  "acct_type_code",
  "trade_date",
  "transaction_id"
] as const;

export async function loadBenchmarkSamplePool(
  client: RedisClientType,
  count: number
): Promise<BenchmarkSamplePool> {
  const limit = Math.max(1, Math.min(5_000, Math.floor(count)));
  const [accounts, securities, positions, transactions] = await Promise.all([
    searchKeys(client, INDEXES.accounts, "*", { limit }),
    searchProjected<SecuritySample>(client, INDEXES.securities, "*", SECURITY_SAMPLE_FIELDS, { limit }),
    searchProjected<PositionSample>(client, INDEXES.positions, "*", POSITION_SAMPLE_FIELDS, { limit }),
    searchProjected<TransactionSample>(client, INDEXES.transactions, "*", TRANSACTION_SAMPLE_FIELDS, { limit })
  ]);

  const pool: BenchmarkSamplePool = {
    accounts: accounts.keys.flatMap(accountIdFromKey),
    securities: securities.rows,
    positions: positions.rows,
    transactions: transactions.rows
  };
  assertSamplePool(pool);
  return pool;
}

export async function loadBenchmarkAccountIds(
  client: RedisClientType,
  count: number
): Promise<string[]> {
  const limit = Math.max(1, Math.min(5_000, Math.floor(count)));
  const accounts = await searchKeys(client, INDEXES.accounts, "*", { limit });
  const accountIds = accounts.keys.flatMap(accountIdFromKey);
  if (accountIds.length === 0) throw new Error("Benchmark sample pool has no accounts");
  return accountIds;
}

export function selectQuerySample(
  pool: BenchmarkSamplePool,
  pattern: QueryPattern,
  random: () => number
): QuerySample {
  assertSamplePool(pool);
  const transaction = choose(pool.transactions, random);
  const base: QuerySample = { ...transaction };

  switch (pattern) {
    case "accountById":
    case "positionsByAccount":
    case "accountPortfolioJoin":
    case "accountActivityJoin":
    case "accountSnapshot":
      base.account_id = choose(pool.accounts, random);
      return base;
    case "securityById":
    case "securityByNo": {
      const security = choose(pool.securities, random);
      base.security_id = security.security_id;
      base.security_no = security.security_no;
      return base;
    }
    case "positionByComposite": {
      const position = choose(pool.positions, random);
      return { ...base, ...position };
    }
    case "transactionById":
    case "transactionsByComposite":
    case "transactionsByAccount":
    case "transactionsBySecurity":
    case "transactionsByAccountSecurity":
      return base;
  }
}

export function firstQuerySample(pool: BenchmarkSamplePool): QuerySample {
  assertSamplePool(pool);
  return { ...pool.transactions[0] };
}

export function createSeededRandom(seed: number): () => number {
  let state = (Math.floor(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function isQueryPattern(value: string | undefined): value is QueryPattern {
  return value !== undefined && (QUERY_PATTERNS as readonly string[]).includes(value);
}

function assertSamplePool(pool: BenchmarkSamplePool): void {
  for (const [name, values] of Object.entries(pool)) {
    if (values.length === 0) throw new Error(`Benchmark sample pool has no ${name}`);
  }
}

function choose<T>(values: T[], random: () => number): T {
  const index = Math.min(values.length - 1, Math.floor(random() * values.length));
  return values[Math.max(0, index)];
}

function accountIdFromKey(key: string): string[] {
  const match = /^acct:\{acct:([^{}]+)\}:info$/.exec(key);
  return match ? [match[1]] : [];
}
