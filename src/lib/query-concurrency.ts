import { performance } from "node:perf_hooks";
import { QUERY_PATTERNS, type QueryPattern } from "./benchmark-samples";
import {
  isDirectKeyQueryPattern,
  QUERY_PATTERNS_BY_WORKLOAD_POOL,
  QUERY_WORKLOAD_POOLS,
  patternConcurrencyEnvironmentName,
  queryWorkloadClass,
  type QueryWorkloadClass
} from "./query-workloads";

type PoolConcurrencyState = {
  active: number;
  limit: number;
  queued: number;
  queueLimit: number;
  rejected: number;
  timedOut: number;
};

type PatternConcurrencyState = {
  active: number;
  reservation: number;
  borrowed: number;
  queued: number;
  rejected: number;
  timedOut: number;
};

type DirectKeyConcurrencyState = {
  active: number;
  reserved: number;
  queued: number;
  queueLimit: number;
  rejected: number;
  timedOut: number;
};

export type QueryConcurrencyLimits = Record<QueryWorkloadClass, number>;
export type QueryQueueLimits = Record<QueryWorkloadClass, number>;
export type QueryPatternConcurrencyReservations = Record<QueryPattern, number>;
// Retained for callers that still use the original public type name.
export type QueryPatternConcurrencyLimits = QueryPatternConcurrencyReservations;

export type QueryConcurrencySnapshot = {
  pools: Record<QueryWorkloadClass, PoolConcurrencyState>;
  directKey: DirectKeyConcurrencyState;
  patterns: Record<QueryPattern, PatternConcurrencyState>;
};

export type QueryConcurrencyOptions = {
  queueLimits?: Partial<QueryQueueLimits>;
  directKeyReserved?: number;
  directKeyQueueLimit?: number;
  queueTimeoutMs?: number;
};

type AdmissionLane = "direct-key" | "shared";

type AdmissionDetails = {
  workloadClass: QueryWorkloadClass;
  pattern: QueryPattern;
  admissionLane: AdmissionLane;
  poolActive: number;
  poolLimit: number;
  patternActive: number;
  patternReservation: number;
  patternBorrowed: number;
  queued: boolean;
  queueMs: number;
  queueDepth: number;
  queueLimit: number;
  directKeyActive: number;
  directKeyReserved: number;
  directKeyQueued: number;
  directKeyQueueLimit: number;
};

export type QueryAdmission =
  | (AdmissionDetails & {
      accepted: false;
      rejectedBy: "queue-full" | "queue-timeout" | "request-aborted";
    })
  | (AdmissionDetails & {
      accepted: true;
      release: () => void;
    });

export type QueryConcurrencyController = {
  acquire: (pattern: QueryPattern, signal?: AbortSignal) => Promise<QueryAdmission>;
  snapshot: () => QueryConcurrencySnapshot;
};

type QueueWaiter = {
  pattern: QueryPattern;
  workloadClass: QueryWorkloadClass;
  lane: AdmissionLane;
  enqueuedAt: number;
  resolve: (admission: QueryAdmission) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: NodeJS.Timeout;
};

export function createQueryConcurrencyController(
  poolLimits: QueryConcurrencyLimits,
  patternReservations: QueryPatternConcurrencyReservations = defaultPatternReservations(poolLimits),
  options: QueryConcurrencyOptions = {}
): QueryConcurrencyController {
  for (const pool of QUERY_WORKLOAD_POOLS) {
    validatePositiveInteger(`${pool} pool limit`, poolLimits[pool]);
  }

  const queueLimits = normalizeQueueLimits(options.queueLimits);
  for (const pool of QUERY_WORKLOAD_POOLS) {
    validateNonNegativeInteger(`${pool} queue limit`, queueLimits[pool]);
  }

  const directKeyReserved =
    options.directKeyReserved ?? Math.max(1, Math.floor(poolLimits.light / 2));
  const directKeyQueueLimit = options.directKeyQueueLimit ?? 0;
  const queueTimeoutMs = options.queueTimeoutMs ?? 250;
  validatePositiveInteger("direct-key reserved concurrency", directKeyReserved);
  if (directKeyReserved > poolLimits.light) {
    throw new Error(
      `direct-key reserved concurrency ${directKeyReserved} cannot exceed light pool limit ${poolLimits.light}`
    );
  }
  validateNonNegativeInteger("direct-key queue limit", directKeyQueueLimit);
  validatePositiveInteger("query queue timeout", queueTimeoutMs);

  for (const pattern of QUERY_PATTERNS) {
    validatePositiveInteger(`${pattern} pattern reservation`, patternReservations[pattern]);
    const pool = queryWorkloadClass(pattern);
    if (patternReservations[pattern] > poolLimits[pool]) {
      throw new Error(
        `${pattern} reservation ${patternReservations[pattern]} cannot exceed ${pool} pool limit ${poolLimits[pool]}`
      );
    }
  }

  const pools = Object.fromEntries(
    QUERY_WORKLOAD_POOLS.map((pool) => [
      pool,
      createPoolState(poolLimits[pool], queueLimits[pool])
    ])
  ) as Record<QueryWorkloadClass, PoolConcurrencyState>;
  const patterns = Object.fromEntries(
    QUERY_PATTERNS.map((pattern) => [pattern, createPatternState(patternReservations[pattern])])
  ) as Record<QueryPattern, Omit<PatternConcurrencyState, "borrowed">>;
  const directKey = createDirectKeyState(directKeyReserved, directKeyQueueLimit);
  const sharedQueues = Object.fromEntries(
    QUERY_WORKLOAD_POOLS.map((pool) => [pool, [] as QueueWaiter[]])
  ) as Record<QueryWorkloadClass, QueueWaiter[]>;
  const directKeyQueue: QueueWaiter[] = [];

  const laneFor = (pattern: QueryPattern): AdmissionLane =>
    isDirectKeyQueryPattern(pattern) ? "direct-key" : "shared";

  const queueFor = (
    workloadClass: QueryWorkloadClass,
    lane: AdmissionLane
  ): QueueWaiter[] => (lane === "direct-key" ? directKeyQueue : sharedQueues[workloadClass]);

  const queueLimitFor = (
    workloadClass: QueryWorkloadClass,
    lane: AdmissionLane
  ): number => (lane === "direct-key" ? directKey.queueLimit : pools[workloadClass].queueLimit);

  const details = (
    pattern: QueryPattern,
    queued: boolean,
    queueMs: number
  ): AdmissionDetails => {
    const workloadClass = queryWorkloadClass(pattern);
    const lane = laneFor(pattern);
    const poolState = pools[workloadClass];
    const patternState = patterns[pattern];
    return {
      workloadClass,
      pattern,
      admissionLane: lane,
      poolActive: poolState.active,
      poolLimit: poolState.limit,
      patternActive: patternState.active,
      patternReservation: patternState.reservation,
      patternBorrowed: Math.max(0, patternState.active - patternState.reservation),
      queued,
      queueMs: roundMs(queueMs),
      queueDepth: queueFor(workloadClass, lane).length,
      queueLimit: queueLimitFor(workloadClass, lane),
      directKeyActive: directKey.active,
      directKeyReserved: directKey.reserved,
      directKeyQueued: directKey.queued,
      directKeyQueueLimit: directKey.queueLimit
    };
  };

  const canStart = (pattern: QueryPattern): boolean => {
    const workloadClass = queryWorkloadClass(pattern);
    const poolState = pools[workloadClass];
    if (poolState.active >= poolState.limit) return false;
    if (workloadClass !== "light" || isDirectKeyQueryPattern(pattern)) return true;

    const sharedActive = poolState.active - directKey.active;
    return sharedActive < poolState.limit - directKey.reserved;
  };

  let drain = (_workloadClass: QueryWorkloadClass): void => undefined;

  const start = (
    pattern: QueryPattern,
    queued: boolean,
    queueMs: number
  ): QueryAdmission => {
    const workloadClass = queryWorkloadClass(pattern);
    const poolState = pools[workloadClass];
    const patternState = patterns[pattern];
    poolState.active += 1;
    patternState.active += 1;
    if (isDirectKeyQueryPattern(pattern)) directKey.active += 1;

    let released = false;
    return {
      accepted: true,
      ...details(pattern, queued, queueMs),
      release() {
        if (released) return;
        released = true;
        poolState.active = Math.max(0, poolState.active - 1);
        patternState.active = Math.max(0, patternState.active - 1);
        if (isDirectKeyQueryPattern(pattern)) {
          directKey.active = Math.max(0, directKey.active - 1);
        }
        drain(workloadClass);
      }
    };
  };

  const removeQueued = (waiter: QueueWaiter): boolean => {
    const queue = queueFor(waiter.workloadClass, waiter.lane);
    const index = queue.indexOf(waiter);
    if (index < 0) return false;
    queue.splice(index, 1);
    patterns[waiter.pattern].queued = Math.max(0, patterns[waiter.pattern].queued - 1);
    if (waiter.lane === "direct-key") {
      directKey.queued = Math.max(0, directKey.queued - 1);
    } else {
      pools[waiter.workloadClass].queued = Math.max(
        0,
        pools[waiter.workloadClass].queued - 1
      );
    }
    return true;
  };

  const clearWaiter = (waiter: QueueWaiter): void => {
    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  };

  const recordRejection = (
    pattern: QueryPattern,
    reason: "queue-full" | "queue-timeout" | "request-aborted"
  ): void => {
    const workloadClass = queryWorkloadClass(pattern);
    pools[workloadClass].rejected += 1;
    patterns[pattern].rejected += 1;
    if (isDirectKeyQueryPattern(pattern)) directKey.rejected += 1;
    if (reason === "queue-timeout") {
      pools[workloadClass].timedOut += 1;
      patterns[pattern].timedOut += 1;
      if (isDirectKeyQueryPattern(pattern)) directKey.timedOut += 1;
    }
  };

  const rejectWaiter = (
    waiter: QueueWaiter,
    reason: "queue-timeout" | "request-aborted"
  ): void => {
    if (!removeQueued(waiter)) return;
    clearWaiter(waiter);
    recordRejection(waiter.pattern, reason);
    waiter.resolve({
      accepted: false,
      rejectedBy: reason,
      ...details(waiter.pattern, true, performance.now() - waiter.enqueuedAt)
    });
    drain(waiter.workloadClass);
  };

  const chooseWaiter = (workloadClass: QueryWorkloadClass): QueueWaiter | undefined => {
    const shared = sharedQueues[workloadClass][0];
    if (workloadClass !== "light") {
      return shared && canStart(shared.pattern) ? shared : undefined;
    }

    const direct = directKeyQueue[0];
    if (direct && directKey.active < directKey.reserved && canStart(direct.pattern)) {
      return direct;
    }

    const eligible = [direct, shared].filter(
      (waiter): waiter is QueueWaiter => Boolean(waiter && canStart(waiter.pattern))
    );
    return eligible.sort((left, right) => left.enqueuedAt - right.enqueuedAt)[0];
  };

  const startWaiter = (waiter: QueueWaiter): void => {
    if (!removeQueued(waiter)) return;
    clearWaiter(waiter);
    waiter.resolve(start(waiter.pattern, true, performance.now() - waiter.enqueuedAt));
  };

  drain = (workloadClass: QueryWorkloadClass): void => {
    while (pools[workloadClass].active < pools[workloadClass].limit) {
      const waiter = chooseWaiter(workloadClass);
      if (!waiter) return;
      startWaiter(waiter);
    }
  };

  const enqueue = (
    pattern: QueryPattern,
    signal?: AbortSignal
  ): Promise<QueryAdmission> => {
    const workloadClass = queryWorkloadClass(pattern);
    const lane = laneFor(pattern);
    const queue = queueFor(workloadClass, lane);
    const queueLimit = queueLimitFor(workloadClass, lane);
    if (queue.length >= queueLimit) {
      recordRejection(pattern, "queue-full");
      return Promise.resolve({
        accepted: false,
        rejectedBy: "queue-full",
        ...details(pattern, false, 0)
      });
    }
    if (signal?.aborted) {
      recordRejection(pattern, "request-aborted");
      return Promise.resolve({
        accepted: false,
        rejectedBy: "request-aborted",
        ...details(pattern, false, 0)
      });
    }

    return new Promise<QueryAdmission>((resolve) => {
      const waiter: QueueWaiter = {
        pattern,
        workloadClass,
        lane,
        enqueuedAt: performance.now(),
        resolve,
        signal
      };
      queue.push(waiter);
      patterns[pattern].queued += 1;
      if (lane === "direct-key") {
        directKey.queued += 1;
      } else {
        pools[workloadClass].queued += 1;
      }

      waiter.timeout = setTimeout(
        () => rejectWaiter(waiter, "queue-timeout"),
        queueTimeoutMs
      );
      if (signal) {
        waiter.abortListener = () => rejectWaiter(waiter, "request-aborted");
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
    });
  };

  const snapshot = (): QueryConcurrencySnapshot => ({
    pools: clonePoolState(pools),
    directKey: { ...directKey },
    patterns: Object.fromEntries(
      QUERY_PATTERNS.map((pattern) => {
        const value = patterns[pattern];
        return [
          pattern,
          {
            ...value,
            borrowed: Math.max(0, value.active - value.reservation)
          }
        ];
      })
    ) as QueryConcurrencySnapshot["patterns"]
  });

  return {
    acquire(pattern, signal) {
      if (canStart(pattern)) return Promise.resolve(start(pattern, false, 0));
      return enqueue(pattern, signal);
    },
    snapshot
  };
}

const poolLimits = readPoolLimits();
const directKeyReserved = readPositiveInteger(
  "API_DIRECT_KEY_RESERVED_CONCURRENCY",
  Math.max(1, Math.floor(poolLimits.light / 2))
);

export const queryConcurrency = createQueryConcurrencyController(
  poolLimits,
  readPatternReservations(poolLimits),
  {
    queueLimits: readQueueLimits(poolLimits),
    directKeyReserved,
    directKeyQueueLimit: readNonNegativeInteger(
      "API_MAX_QUEUED_DIRECT_KEY",
      directKeyReserved
    ),
    queueTimeoutMs: readPositiveInteger("API_QUERY_QUEUE_TIMEOUT_MS", 250)
  }
);

function readPoolLimits(): QueryConcurrencyLimits {
  return {
    light: readPositiveInteger("API_MAX_CONCURRENT_LIGHT", 128),
    positions: readPositiveInteger("API_MAX_CONCURRENT_POSITIONS", 32),
    transactions: readPositiveInteger("API_MAX_CONCURRENT_TRANSACTIONS", 32),
    portfolio: readPositiveInteger("API_MAX_CONCURRENT_PORTFOLIO", 16),
    activity: readPositiveInteger("API_MAX_CONCURRENT_ACTIVITY", 16),
    snapshot: readPositiveInteger("API_MAX_CONCURRENT_SNAPSHOT", 32)
  };
}

function readQueueLimits(limits: QueryConcurrencyLimits): QueryQueueLimits {
  return {
    light: readNonNegativeInteger("API_MAX_QUEUED_LIGHT", Math.floor(limits.light / 2)),
    positions: readNonNegativeInteger(
      "API_MAX_QUEUED_POSITIONS",
      Math.floor(limits.positions / 2)
    ),
    transactions: readNonNegativeInteger(
      "API_MAX_QUEUED_TRANSACTIONS",
      Math.floor(limits.transactions / 2)
    ),
    portfolio: readNonNegativeInteger(
      "API_MAX_QUEUED_PORTFOLIO",
      Math.floor(limits.portfolio / 2)
    ),
    activity: readNonNegativeInteger(
      "API_MAX_QUEUED_ACTIVITY",
      Math.floor(limits.activity / 2)
    ),
    snapshot: readNonNegativeInteger(
      "API_MAX_QUEUED_SNAPSHOT",
      Math.floor(limits.snapshot / 2)
    )
  };
}

function readPatternReservations(limits: QueryConcurrencyLimits): QueryPatternConcurrencyReservations {
  const defaults = defaultPatternReservations(limits);
  return Object.fromEntries(
    QUERY_PATTERNS.map((pattern) => [
      pattern,
      readPositiveInteger(patternConcurrencyEnvironmentName(pattern), defaults[pattern])
    ])
  ) as QueryPatternConcurrencyReservations;
}

function defaultPatternReservations(limits: QueryConcurrencyLimits): QueryPatternConcurrencyReservations {
  return Object.fromEntries(
    QUERY_WORKLOAD_POOLS.flatMap((pool) => {
      const patterns = QUERY_PATTERNS_BY_WORKLOAD_POOL[pool];
      const fairShare = Math.max(1, Math.floor(limits[pool] / patterns.length));
      return patterns.map((pattern) => [pattern, fairShare] as const);
    })
  ) as QueryPatternConcurrencyReservations;
}

function normalizeQueueLimits(limits: Partial<QueryQueueLimits> | undefined): QueryQueueLimits {
  return Object.fromEntries(
    QUERY_WORKLOAD_POOLS.map((pool) => [pool, limits?.[pool] ?? 0])
  ) as QueryQueueLimits;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${value}`);
  }
  return parsed;
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function createPoolState(limit: number, queueLimit: number): PoolConcurrencyState {
  return { active: 0, limit, queued: 0, queueLimit, rejected: 0, timedOut: 0 };
}

function createPatternState(reservation: number): Omit<PatternConcurrencyState, "borrowed"> {
  return { active: 0, reservation, queued: 0, rejected: 0, timedOut: 0 };
}

function createDirectKeyState(reserved: number, queueLimit: number): DirectKeyConcurrencyState {
  return {
    active: 0,
    reserved,
    queued: 0,
    queueLimit,
    rejected: 0,
    timedOut: 0
  };
}

function clonePoolState<K extends string>(
  state: Record<K, PoolConcurrencyState>
): Record<K, PoolConcurrencyState> {
  return Object.fromEntries(
    Object.entries<PoolConcurrencyState>(state).map(([key, value]) => [key, { ...value }])
  ) as Record<K, PoolConcurrencyState>;
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}
