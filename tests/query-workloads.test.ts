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
  isDirectKeyQueryPattern,
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

test("direct-key query classification is explicit and excludes indexed searches", () => {
  for (const pattern of [
    "accountById",
    "securityById",
    "positionByComposite",
    "transactionById"
  ] as const) {
    assert.equal(isDirectKeyQueryPattern(pattern), true);
  }
  assert.equal(isDirectKeyQueryPattern("securityByNo"), false);
  assert.equal(isDirectKeyQueryPattern("transactionsByAccountSecurity"), false);
  assert.equal(isDirectKeyQueryPattern("securityByNoDirect"), false);
  assert.equal(isDirectKeyQueryPattern("transactionsBySecurityMaterialized"), false);
  assert.equal(
    isDirectKeyQueryPattern("transactionsByAccountSecurityMaterialized"),
    false
  );
  assert.equal(
    queryWorkloadClass("transactionsBySecurityMaterialized"),
    queryWorkloadClass("transactionsBySecurity")
  );
});

test("query admission borrows above pattern reservations until the pool is full", async () => {
  const controller = createQueryConcurrencyController(poolLimits, patternReservations);
  const account = await controller.acquire("accountById");
  const borrowedAccount = await controller.acquire("accountById");
  const security = await controller.acquire("securityById");
  const thirdAccount = await controller.acquire("accountById");
  const fourthAccount = await controller.acquire("accountById");
  const fifthAccount = await controller.acquire("accountById");
  const rejectedAccount = await controller.acquire("accountById");
  const position = await controller.acquire("positionsByAccount");
  const rejectedPosition = await controller.acquire("positionsByAccount");

  assert.equal(account.accepted, true);
  assert.equal(borrowedAccount.accepted, true);
  if (borrowedAccount.accepted) {
    assert.equal(borrowedAccount.patternReservation, 1);
    assert.equal(borrowedAccount.patternBorrowed, 1);
  }
  assert.equal(rejectedAccount.accepted, false);
  if (!rejectedAccount.accepted) {
    assert.equal(rejectedAccount.rejectedBy, "queue-full");
    assert.equal(rejectedAccount.admissionLane, "direct-key");
    assert.equal(rejectedAccount.poolActive, 6);
    assert.equal(rejectedAccount.queueLimit, 0);
  }
  assert.equal(security.accepted, true);
  assert.equal(thirdAccount.accepted, true);
  assert.equal(fourthAccount.accepted, true);
  assert.equal(fifthAccount.accepted, true);
  assert.equal(position.accepted, true);
  assert.equal(rejectedPosition.accepted, false);
  if (!rejectedPosition.accepted) assert.equal(rejectedPosition.rejectedBy, "queue-full");

  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.pools.light, {
    active: 6,
    limit: 6,
    queued: 0,
    queueLimit: 0,
    rejected: 1,
    timedOut: 0
  });
  assert.deepEqual(snapshot.pools.positions, {
    active: 1,
    limit: 1,
    queued: 0,
    queueLimit: 0,
    rejected: 1,
    timedOut: 0
  });
  assert.deepEqual(snapshot.patterns.accountById, {
    active: 5,
    reservation: 1,
    borrowed: 4,
    queued: 0,
    rejected: 1,
    timedOut: 0
  });

  if (account.accepted) {
    account.release();
    account.release();
  }
  assert.equal((await controller.acquire("accountById")).accepted, true);
});

test("shared light queries cannot consume direct-key reserved concurrency", async () => {
  const controller = createQueryConcurrencyController(poolLimits, patternReservations, {
    directKeyReserved: 2
  });
  const shared = await Promise.all([
    controller.acquire("securityByNo"),
    controller.acquire("securityByNo"),
    controller.acquire("securityByNo"),
    controller.acquire("securityByNo")
  ]);
  assert(shared.every((admission) => admission.accepted));

  const rejectedShared = await controller.acquire("securityByNo");
  assert.equal(rejectedShared.accepted, false);
  if (!rejectedShared.accepted) assert.equal(rejectedShared.rejectedBy, "queue-full");

  const firstDirect = await controller.acquire("accountById");
  const secondDirect = await controller.acquire("transactionById");
  assert.equal(firstDirect.accepted, true);
  assert.equal(secondDirect.accepted, true);
  assert.deepEqual(controller.snapshot().directKey, {
    active: 2,
    reserved: 2,
    queued: 0,
    queueLimit: 0,
    rejected: 0,
    timedOut: 0
  });
});

test("bounded queues defer one request and reject when the queue is full", async () => {
  const controller = createQueryConcurrencyController(poolLimits, patternReservations, {
    queueLimits: { positions: 1 },
    queueTimeoutMs: 100
  });
  const active = await controller.acquire("positionsByAccount");
  assert.equal(active.accepted, true);

  const queuedPromise = controller.acquire("positionsByAccount");
  assert.equal(controller.snapshot().pools.positions.queued, 1);

  const rejected = await controller.acquire("positionsByAccount");
  assert.equal(rejected.accepted, false);
  if (!rejected.accepted) assert.equal(rejected.rejectedBy, "queue-full");

  if (active.accepted) active.release();
  const queued = await queuedPromise;
  assert.equal(queued.accepted, true);
  if (queued.accepted) {
    assert.equal(queued.queued, true);
    assert(queued.queueMs >= 0);
    queued.release();
  }
});

test("queued requests time out instead of waiting without a bound", async () => {
  const controller = createQueryConcurrencyController(poolLimits, patternReservations, {
    queueLimits: { snapshot: 1 },
    queueTimeoutMs: 10
  });
  const active = await controller.acquire("accountSnapshot");
  const timedOut = await controller.acquire("accountSnapshot");

  assert.equal(timedOut.accepted, false);
  if (!timedOut.accepted) {
    assert.equal(timedOut.rejectedBy, "queue-timeout");
    assert.equal(timedOut.queued, true);
    assert(timedOut.queueMs >= 0);
  }
  assert.equal(controller.snapshot().pools.snapshot.timedOut, 1);
  if (active.accepted) active.release();
});

test("pattern reservations cannot exceed their pool limit", () => {
  const invalidPatternReservations = { ...patternReservations, accountById: 7 } satisfies Record<QueryPattern, number>;
  assert.throws(
    () => createQueryConcurrencyController(poolLimits, invalidPatternReservations),
    /reservation 7 cannot exceed light pool limit/
  );
});
