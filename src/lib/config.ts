export type RedisConfig = {
  url: string;
  clusterRootNodes: string[];
  clusterMode: boolean;
  username?: string;
  password?: string;
  tls: boolean;
  poolSize: number;
};

export type SeedConfig = {
  accountCount: number;
  securityCount: number;
  positionsPerAccount: number;
  transactionCount: number;
  securityBytes: number;
  positionBytes: number;
  transactionBytes: number;
  batchSize: number;
  writeConcurrency: number;
  snapshotConcurrency: number;
  dropIndexesBeforeLoad: boolean;
  skipSnapshots: boolean;
  randomSeed: number;
  partitionIndex: number;
  partitionCount: number;
  resume: boolean;
  resetCheckpoints: boolean;
  asOfDate: string;
  indexTimeoutMs: number;
};

function readInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

export function getRedisConfig(): RedisConfig {
  const clusterRootNodes = (process.env.REDIS_CLUSTER_ROOT_NODES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeRedisUrl);
  const url = process.env.REDIS_URL ?? clusterRootNodes[0];
  if (!url) {
    throw new Error("REDIS_URL or REDIS_CLUSTER_ROOT_NODES is required.");
  }

  return {
    url,
    clusterRootNodes,
    clusterMode: clusterRootNodes.length > 0,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === "true" || url.startsWith("rediss://"),
    poolSize: readInt("REDIS_POOL_SIZE", 4)
  };
}

function normalizeRedisUrl(value: string): string {
  return value.includes("://") ? value : `redis://${value}`;
}

export function getSeedConfig(): SeedConfig {
  const accountCount = readInt("SEED_ACCOUNTS", 100);
  const partitionCount = readInt("SEED_PARTITION_COUNT", 1);
  const partitionIndex = readNonNegativeInt("SEED_PARTITION_INDEX", 0);
  if (partitionIndex >= partitionCount) {
    throw new Error(`SEED_PARTITION_INDEX must be between 0 and ${partitionCount - 1}`);
  }

  return {
    accountCount,
    securityCount: readInt("SEED_SECURITIES", 500),
    positionsPerAccount: readInt("SEED_POSITIONS_PER_ACCOUNT", 60),
    transactionCount: readInt("SEED_TRANSACTIONS", readInt("SEED_TRANSACTIONS_PER_ACCOUNT", 300) * accountCount),
    securityBytes: readInt("SEED_SECURITY_BYTES", 8_192),
    positionBytes: readInt("SEED_POSITION_BYTES", 8_192),
    transactionBytes: readInt("SEED_TRANSACTION_BYTES", 8_192),
    batchSize: readInt("SEED_BATCH_SIZE", 500),
    writeConcurrency: readInt("SEED_WRITE_CONCURRENCY", 4),
    snapshotConcurrency: readInt("SEED_SNAPSHOT_CONCURRENCY", 25),
    dropIndexesBeforeLoad: readBool("SEED_DROP_INDEXES_BEFORE_LOAD"),
    skipSnapshots: readBool("SEED_SKIP_SNAPSHOTS"),
    randomSeed: readInt("SEED_RANDOM", 20_260_518),
    partitionIndex,
    partitionCount,
    resume: readBool("SEED_RESUME", true),
    resetCheckpoints: readBool("SEED_RESET_CHECKPOINTS"),
    asOfDate: process.env.SEED_AS_OF_DATE ?? new Date().toISOString().slice(0, 10),
    indexTimeoutMs: readInt("SEED_INDEX_TIMEOUT_MS", 20 * 60_000)
  };
}
