export type RedisConfig = {
  url: string;
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
};

function readInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

export function getRedisConfig(): RedisConfig {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required. Use a Redis Cloud rediss:// connection string.");
  }

  return {
    url,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === "true" || url.startsWith("rediss://"),
    poolSize: readInt("REDIS_POOL_SIZE", 4)
  };
}

export function getSeedConfig(): SeedConfig {
  const accountCount = readInt("SEED_ACCOUNTS", 100);
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
    randomSeed: readInt("SEED_RANDOM", 20_260_518)
  };
}
