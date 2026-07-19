import { QUERY_PATTERNS, type QueryPattern } from "./benchmark-samples";
import {
  QUERY_PATTERNS_BY_WORKLOAD_POOL,
  QUERY_WORKLOAD_POOLS,
  patternConcurrencyEnvironmentName,
  queryWorkloadClass,
  type QueryWorkloadClass
} from "./query-workloads";

type PoolConcurrencyState = {
  active: number;
  limit: number;
  rejected: number;
};

type PatternConcurrencyState = {
  active: number;
  reservation: number;
  borrowed: number;
  rejected: number;
};

export type QueryConcurrencyLimits = Record<QueryWorkloadClass, number>;
export type QueryPatternConcurrencyReservations = Record<QueryPattern, number>;
// Retained for callers that still use the original public type name.
export type QueryPatternConcurrencyLimits = QueryPatternConcurrencyReservations;

export type QueryConcurrencySnapshot = {
  pools: Record<QueryWorkloadClass, PoolConcurrencyState>;
  patterns: Record<QueryPattern, PatternConcurrencyState>;
};

type AdmissionDetails = {
  workloadClass: QueryWorkloadClass;
  pattern: QueryPattern;
  poolActive: number;
  poolLimit: number;
  patternActive: number;
  patternReservation: number;
  patternBorrowed: number;
};

export type QueryAdmission =
  | (AdmissionDetails & {
      accepted: false;
      rejectedBy: "pool";
    })
  | (AdmissionDetails & {
      accepted: true;
      release: () => void;
    });

export type QueryConcurrencyController = {
  acquire: (pattern: QueryPattern) => QueryAdmission;
  snapshot: () => QueryConcurrencySnapshot;
};

export function createQueryConcurrencyController(
  poolLimits: QueryConcurrencyLimits,
  patternReservations: QueryPatternConcurrencyReservations = defaultPatternReservations(poolLimits)
): QueryConcurrencyController {
  for (const pool of QUERY_WORKLOAD_POOLS) validatePositiveInteger(`${pool} pool limit`, poolLimits[pool]);
  for (const pattern of QUERY_PATTERNS) {
    validatePositiveInteger(`${pattern} pattern reservation`, patternReservations[pattern]);
    const pool = queryWorkloadClass(pattern);
    if (patternReservations[pattern] > poolLimits[pool]) {
      throw new Error(
        `${pattern} concurrency reservation ${patternReservations[pattern]} cannot exceed ${pool} pool limit ${poolLimits[pool]}`
      );
    }
  }

  const pools = Object.fromEntries(
    QUERY_WORKLOAD_POOLS.map((pool) => [pool, createPoolState(poolLimits[pool])])
  ) as Record<QueryWorkloadClass, PoolConcurrencyState>;
  const patterns = Object.fromEntries(
    QUERY_PATTERNS.map((pattern) => [pattern, createPatternState(patternReservations[pattern])])
  ) as Record<QueryPattern, Omit<PatternConcurrencyState, "borrowed">>;

  const snapshot = (): QueryConcurrencySnapshot => ({
    pools: clonePoolState(pools),
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
    acquire(pattern) {
      const workloadClass = queryWorkloadClass(pattern);
      const poolState = pools[workloadClass];
      const patternState = patterns[pattern];
      const details = () => ({
        workloadClass,
        pattern,
        poolActive: poolState.active,
        poolLimit: poolState.limit,
        patternActive: patternState.active,
        patternReservation: patternState.reservation,
        patternBorrowed: Math.max(0, patternState.active - patternState.reservation)
      });

      if (poolState.active >= poolState.limit) {
        poolState.rejected += 1;
        patternState.rejected += 1;
        return { accepted: false, rejectedBy: "pool", ...details() };
      }

      poolState.active += 1;
      patternState.active += 1;
      let released = false;
      return {
        accepted: true,
        ...details(),
        release() {
          if (released) return;
          released = true;
          poolState.active = Math.max(0, poolState.active - 1);
          patternState.active = Math.max(0, patternState.active - 1);
        }
      };
    },
    snapshot() {
      return snapshot();
    }
  };
}

const poolLimits = readPoolLimits();

export const queryConcurrency = createQueryConcurrencyController(
  poolLimits,
  readPatternReservations(poolLimits)
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

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function createPoolState(limit: number): PoolConcurrencyState {
  return { active: 0, limit, rejected: 0 };
}

function createPatternState(reservation: number): Omit<PatternConcurrencyState, "borrowed"> {
  return { active: 0, reservation, rejected: 0 };
}

function clonePoolState<K extends string>(state: Record<K, PoolConcurrencyState>): Record<K, PoolConcurrencyState> {
  return Object.fromEntries(
    Object.entries<PoolConcurrencyState>(state).map(([key, value]) => [key, { ...value }])
  ) as Record<K, PoolConcurrencyState>;
}
