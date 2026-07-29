import type { QueryPattern } from "./benchmark-samples";

export const DIRECT_QUERY_PATTERNS = [
  "accountById",
  "securityById",
  "securityByNo",
  "positionByComposite",
  "positionsByAccount",
  "transactionById",
  "transactionsByAccount",
  "transactionsBySecurity",
  "transactionsByAccountSecurity",
  "accountPortfolioJoin",
  "accountActivityJoin",
  "accountSnapshot"
] as const satisfies readonly QueryPattern[];

export type DirectQueryPattern = (typeof DIRECT_QUERY_PATTERNS)[number];

const QUERY_WEIGHTS = {
  accountById: 1,
  securityById: 1,
  securityByNo: 1,
  positionByComposite: 1,
  positionsByAccount: 1,
  transactionById: 1,
  transactionsByAccount: 1,
  transactionsBySecurity: 1,
  transactionsByAccountSecurity: 1,
  accountPortfolioJoin: 5,
  accountActivityJoin: 5,
  accountSnapshot: 1
} as const satisfies Record<DirectQueryPattern, number>;

export function directQueryTargets(totalTargetRps: number): Record<DirectQueryPattern, number> {
  if (!Number.isFinite(totalTargetRps) || totalTargetRps <= 0) {
    throw new Error("Direct query total target must be a positive number.");
  }
  const totalWeight = Object.values(QUERY_WEIGHTS).reduce((total, weight) => total + weight, 0);
  return Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [
      pattern,
      (totalTargetRps * QUERY_WEIGHTS[pattern]) / totalWeight
    ])
  ) as Record<DirectQueryPattern, number>;
}

export function directQueryWeight(pattern: DirectQueryPattern): number {
  return QUERY_WEIGHTS[pattern];
}

export function parseDirectQueryPatterns(value?: string): DirectQueryPattern[] {
  if (!value?.trim()) return [...DIRECT_QUERY_PATTERNS];
  const patterns = value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    throw new Error("DIRECT_QUERY_PATTERNS must contain at least one query pattern.");
  }
  const unknown = patterns.filter(
    (pattern): pattern is string =>
      !DIRECT_QUERY_PATTERNS.includes(pattern as DirectQueryPattern)
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown direct query pattern(s): ${unknown.join(", ")}`);
  }
  return [...new Set(patterns)] as DirectQueryPattern[];
}

export function directQueryTargetsForPatterns(
  totalTargetRps: number,
  patterns: readonly DirectQueryPattern[]
): Record<DirectQueryPattern, number> {
  if (!Number.isFinite(totalTargetRps) || totalTargetRps <= 0) {
    throw new Error("Direct query total target must be a positive number.");
  }
  if (patterns.length === 0) {
    throw new Error("At least one direct query pattern is required.");
  }
  const selected = new Set(patterns);
  const selectedWeight = patterns.reduce(
    (total, pattern) => total + QUERY_WEIGHTS[pattern],
    0
  );
  return Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [
      pattern,
      selected.has(pattern)
        ? (totalTargetRps * QUERY_WEIGHTS[pattern]) / selectedWeight
        : 0
    ])
  ) as Record<DirectQueryPattern, number>;
}
