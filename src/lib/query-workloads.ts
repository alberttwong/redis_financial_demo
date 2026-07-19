import type { QueryPattern } from "./benchmark-samples";

export const LIGHT_QUERY_PATTERNS = [
  "accountById",
  "securityById",
  "securityByNo",
  "positionByComposite",
  "transactionById",
  "transactionsByComposite",
  "transactionsByAccountSecurity"
] as const satisfies readonly QueryPattern[];

export const POSITIONS_QUERY_PATTERNS = [
  "positionsByAccount"
] as const satisfies readonly QueryPattern[];

export const TRANSACTION_COLLECTION_QUERY_PATTERNS = [
  "transactionsByAccount",
  "transactionsBySecurity"
] as const satisfies readonly QueryPattern[];

export const PORTFOLIO_QUERY_PATTERNS = [
  "accountPortfolioJoin"
] as const satisfies readonly QueryPattern[];

export const ACTIVITY_QUERY_PATTERNS = [
  "accountActivityJoin"
] as const satisfies readonly QueryPattern[];

export const SNAPSHOT_QUERY_PATTERNS = [
  "accountSnapshot"
] as const satisfies readonly QueryPattern[];

export const QUERY_WORKLOAD_POOLS = [
  "light",
  "positions",
  "transactions",
  "portfolio",
  "activity",
  "snapshot"
] as const;

export type QueryWorkloadClass = (typeof QUERY_WORKLOAD_POOLS)[number];
export type ApiWorkloadClass = QueryWorkloadClass | "mixed";

export const QUERY_PATTERNS_BY_WORKLOAD_POOL = {
  light: LIGHT_QUERY_PATTERNS,
  positions: POSITIONS_QUERY_PATTERNS,
  transactions: TRANSACTION_COLLECTION_QUERY_PATTERNS,
  portfolio: PORTFOLIO_QUERY_PATTERNS,
  activity: ACTIVITY_QUERY_PATTERNS,
  snapshot: SNAPSHOT_QUERY_PATTERNS
} as const satisfies Record<QueryWorkloadClass, readonly QueryPattern[]>;

// Retained as a catalog for documentation and callers that need the non-light set.
export const HEAVY_QUERY_PATTERNS = [
  ...POSITIONS_QUERY_PATTERNS,
  ...TRANSACTION_COLLECTION_QUERY_PATTERNS,
  ...PORTFOLIO_QUERY_PATTERNS,
  ...ACTIVITY_QUERY_PATTERNS,
  ...SNAPSHOT_QUERY_PATTERNS
] as const satisfies readonly QueryPattern[];

const WORKLOAD_POOL_BY_PATTERN = new Map<QueryPattern, QueryWorkloadClass>(
  QUERY_WORKLOAD_POOLS.flatMap((pool) =>
    QUERY_PATTERNS_BY_WORKLOAD_POOL[pool].map((pattern) => [pattern, pool] as const)
  )
);

export function queryWorkloadClass(pattern: QueryPattern): QueryWorkloadClass {
  const pool = WORKLOAD_POOL_BY_PATTERN.get(pattern);
  if (!pool) throw new Error(`Query pattern ${pattern} has no workload pool`);
  return pool;
}

export function parseApiWorkloadClass(value: string | undefined): ApiWorkloadClass {
  const normalized = value?.trim().toLowerCase() || "mixed";
  if (normalized === "mixed" || QUERY_WORKLOAD_POOLS.some((pool) => pool === normalized)) {
    return normalized as ApiWorkloadClass;
  }
  throw new Error(
    `API_WORKLOAD_CLASS must be mixed or one of ${QUERY_WORKLOAD_POOLS.join(", ")}; received ${value}`
  );
}

export function getApiWorkloadClass(): ApiWorkloadClass {
  return parseApiWorkloadClass(process.env.API_WORKLOAD_CLASS);
}

export function patternConcurrencyEnvironmentName(pattern: QueryPattern): string {
  return `API_MAX_CONCURRENT_PATTERN_${pattern.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;
}
