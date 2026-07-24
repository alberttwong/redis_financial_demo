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
