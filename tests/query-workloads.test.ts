import assert from "node:assert/strict";
import test from "node:test";
import { QUERY_PATTERNS, type QueryPattern } from "../src/lib/benchmark-samples";
import {
  createQueryConcurrencyController,
  type QueryConcurrencyLimits,
  type QueryPatternConcurrencyLimits
} from "../src/lib/query-concurrency";
import {
  QUERY_PATTERNS_BY_WORKLOAD_POOL,
  QUERY_WORKLOAD_POOLS,
  parseApiWorkloadClass,
  patternConcurrencyEnvironmentName,
  queryWorkloadClass
} from "../src/lib/query-workloads";

const poolLimits: QueryConcurrencyLimits = {
  light: 6,
  positions: 1,
  transactions: 2,
  portfolio: 1,
  activity: 1,
  snapshot: 1
};

const patternReservations = Object.fromEntries(
  QUERY_PATTERNS.map((pattern) => [pattern, 1])
) as QueryPatternConcurrencyLimits;

test("every query pattern belongs to exactly one workload pool", () => {
  const classifiedPatterns = QUERY_WORKLOAD_POOLS.flatMap(
    (pool) => [...QUERY_PATTERNS_BY_WORKLOAD_POOL[pool]]
  );

  assert.deepEqual(new Set(classifiedPatterns), new Set(QUERY_PATTERNS));
  assert.equal(classifiedPatterns.length, QUERY_PATTERNS.length);
  for (const pool of QUERY_WORKLOAD_POOLS) {
    for (const pattern of QUERY_PATTERNS_BY_WORKLOAD_POOL[pool]) {
      assert.equal(queryWorkloadClass(pattern), pool);
    }
  }
});

test("API workload class defaults to mixed and accepts all six pools", () => {
  assert.equal(parseApiWorkloadClass(undefined), "mixed");
  assert.equal(parseApiWorkloadClass(" LIGHT "), "light");
  for (const pool of QUERY_WORKLOAD_POOLS) assert.equal(parseApiWorkloadClass(pool), pool);
  assert.throws(() => parseApiWorkloadClass("heavy"), /must be mixed or one of/);
});

test("per-pattern concurrency environment names are stable", () => {
  assert.equal(
    patternConcurrencyEnvironmentName("accountPortfolioJoin"),
    "API_MAX_CONCURRENT_PATTERN_ACCOUNT_PORTFOLIO_JOIN"
  );
});

test("query admission borrows above pattern reservations until the pool is full", () => {
  const controller = createQueryConcurrencyController(poolLimits, patternReservations);
  const account = controller.acquire("accountById");
  const borrowedAccount = controller.acquire("accountById");
  const security = controller.acquire("securityById");
  const thirdAccount = controller.acquire("accountById");
  const fourthAccount = controller.acquire("accountById");
  const fifthAccount = controller.acquire("accountById");
  const rejectedAccount = controller.acquire("accountById");
  const position = controller.acquire("positionsByAccount");
  const rejectedPosition = controller.acquire("positionsByAccount");

  assert.equal(account.accepted, true);
  assert.equal(borrowedAccount.accepted, true);
  if (borrowedAccount.accepted) {
    assert.equal(borrowedAccount.patternReservation, 1);
    assert.equal(borrowedAccount.patternBorrowed, 1);
  }
  assert.deepEqual(rejectedAccount, {
    accepted: false,
    rejectedBy: "pool",
    workloadClass: "light",
    pattern: "accountById",
    poolActive: 6,
    poolLimit: 6,
    patternActive: 5,
    patternReservation: 1,
    patternBorrowed: 4
  });
  assert.equal(security.accepted, true);
  assert.equal(thirdAccount.accepted, true);
  assert.equal(fourthAccount.accepted, true);
  assert.equal(fifthAccount.accepted, true);
  assert.equal(position.accepted, true);
  assert.equal(rejectedPosition.accepted, false);
  if (!rejectedPosition.accepted) assert.equal(rejectedPosition.rejectedBy, "pool");

  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.pools.light, { active: 6, limit: 6, rejected: 1 });
  assert.deepEqual(snapshot.pools.positions, { active: 1, limit: 1, rejected: 1 });
  assert.deepEqual(snapshot.patterns.accountById, {
    active: 5,
    reservation: 1,
    borrowed: 4,
    rejected: 1
  });

  if (account.accepted) {
    account.release();
    account.release();
  }
  assert.equal(controller.acquire("accountById").accepted, true);
});

test("pattern reservations cannot exceed their pool limit", () => {
  const invalidPatternReservations = { ...patternReservations, accountById: 7 } satisfies Record<QueryPattern, number>;
  assert.throws(
    () => createQueryConcurrencyController(poolLimits, invalidPatternReservations),
    /reservation 7 cannot exceed light pool limit/
  );
});
