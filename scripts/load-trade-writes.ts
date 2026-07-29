import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createSeededRandom, loadBenchmarkAccountIds } from "../src/lib/benchmark-samples";
import { INDEXES } from "../src/lib/indexes";
import { securityKey, snapshotKey } from "../src/lib/keys";
import { jsonGet, jsonGetFields, jsonMGetFields } from "../src/lib/json";
import { SECURITY_PROJECTION_FIELDS } from "../src/lib/projections";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { searchProjected } from "../src/lib/search";
import { tagEquals } from "../src/lib/tag";
import { selectTradeAccountsForShard, transactionForPosition } from "../src/lib/trade-load";
import { applyTransaction, type ApplyTransactionResult } from "../src/lib/transaction-writes";
import type { RedisConnection } from "../src/lib/redis";
import type { PositionSample } from "../src/lib/benchmark-samples";
import type {
  AccountSnapshot,
  PositionRow,
  SecurityProjection,
  TransactionRow
} from "../src/lib/types";

type Counters = {
  started: number;
  completed: number;
  inserted: number;
  insertedDuringWindow: number;
  duplicates: number;
  errors: number;
  dropped: number;
  inFlight: number;
  peakInFlight: number;
  validationsStarted: number;
  validationsPassed: number;
  validationsFailed: number;
  validationsInFlight: number;
};

const TRADE_POSITION_FIELDS = [
  "account_id",
  "security_id",
  "security_no",
  "acct_type_code"
] as const satisfies readonly (keyof PositionSample)[];

async function main() {
  const targetOpsPerSecond = readPositiveNumber(
    "TRADE_TARGET_RPS",
    readPositiveNumber("MEMTIER_TRADE_TARGET_RPS", 30_000)
  );
  const testTimeSeconds = readPositiveNumber("TRADE_TEST_TIME", readPositiveNumber("MEMTIER_TEST_TIME", 60));
  const schedulerTickMs = readPositiveNumber("TRADE_SCHEDULER_TICK_MS", 10);
  const maxInFlight = readPositiveNumber("TRADE_MAX_IN_FLIGHT", 10_000);
  const drainTimeoutMs = readPositiveNumber("TRADE_DRAIN_TIMEOUT_MS", 30_000);
  const samplePoolSize = readPositiveInteger("TRADE_SAMPLE_POOL_SIZE", 1_000);
  const accountDiscoveryPoolSize = readPositiveInteger("TRADE_ACCOUNT_DISCOVERY_POOL_SIZE", 5_000);
  const bootstrapConcurrency = readPositiveNumber("TRADE_BOOTSTRAP_CONCURRENCY", 50);
  const correctnessSampleEvery = readNonNegativeInteger("TRADE_CORRECTNESS_SAMPLE_EVERY", 0);
  const randomSeed = readPositiveNumber("TRADE_RANDOM_SEED", 20_260_714);
  const shardCount = readPositiveInteger("TRADE_SHARD_COUNT", 1);
  const shardIndex = readPositiveInteger("TRADE_SHARD_INDEX", 1);
  if (shardIndex > shardCount) {
    throw new Error(`TRADE_SHARD_INDEX must be between 1 and TRADE_SHARD_COUNT (${shardCount})`);
  }
  const tradePayloadBytes = readPositiveNumber("MEMTIER_TRADE_PAYLOAD_BYTES", 1_024);
  const tradeDate = process.env.MEMTIER_TRADE_DATE ?? new Date().toISOString().slice(0, 10);
  const tradeDateEpoch = Date.parse(`${tradeDate}T00:00:00.000Z`);
  if (!Number.isFinite(tradeDateEpoch)) throw new Error("MEMTIER_TRADE_DATE must use YYYY-MM-DD format");

  const bootstrapClient = await getRedisClient();
  const random = createSeededRandom(randomSeed);
  const accountIds = await loadBenchmarkAccountIds(bootstrapClient, accountDiscoveryPoolSize);
  const sampledAccountIds = selectTradeAccountsForShard(
    accountIds,
    samplePoolSize,
    shardIndex,
    shardCount,
    random
  );
  const positions = await loadPositionsForAccounts(
    bootstrapClient,
    sampledAccountIds,
    bootstrapConcurrency
  );
  const securityIds = [...new Set(positions.map((position) => position.security_id))];
  const securities = await jsonMGetFields<SecurityProjection>(
    bootstrapClient,
    securityIds.map(securityKey),
    SECURITY_PROJECTION_FIELDS
  );
  const securityById = new Map(
    securities
      .filter((security): security is SecurityProjection => Boolean(security))
      .map((security) => [security.security_id, security])
  );
  const missingSecurityId = securityIds.find((securityId) => !securityById.has(securityId));
  if (missingSecurityId) throw new Error(`Missing security projection for ${missingSecurityId}`);
  const positionAccountIds = [...new Set(positions.map((position) => position.account_id))];
  type SnapshotHead = Pick<AccountSnapshot, "account_id" | "revision">;
  const snapshots = await jsonMGetFields<SnapshotHead>(
    bootstrapClient,
    positionAccountIds.map(snapshotKey),
    ["account_id", "revision"]
  );
  const missingSnapshotIndex = snapshots.findIndex(
    (snapshot, index) =>
      !snapshot || snapshot.account_id !== positionAccountIds[index] || !Number.isFinite(snapshot.revision)
  );
  if (missingSnapshotIndex >= 0) {
    throw new Error(`Missing account snapshot for ${positionAccountIds[missingSnapshotIndex]}; rebuild snapshots before load testing`);
  }
  const runId = process.env.MEMTIER_TRADE_RUN_ID ?? `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const payload = "x".repeat(Math.max(0, tradePayloadBytes - 400));

  await waitForScheduledStart();
  const counters: Counters = {
    started: 0,
    completed: 0,
    inserted: 0,
    insertedDuringWindow: 0,
    duplicates: 0,
    errors: 0,
    dropped: 0,
    inFlight: 0,
    peakInFlight: 0,
    validationsStarted: 0,
    validationsPassed: 0,
    validationsFailed: 0,
    validationsInFlight: 0
  };
  const requestTimeoutMs = Math.max(drainTimeoutMs, 30_000);
  const latencyHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
  const validationLatencyHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
  const validationErrors: string[] = [];
  const durationMs = testTimeSeconds * 1_000;
  const targetOperations = Math.floor(targetOpsPerSecond * testTimeSeconds);
  const startedAt = performance.now();
  const measurementEndsAt = startedAt + durationMs;
  let handledSlots = 0;
  let sequence = 0;
  const touchedPositions = new Set<string>();

  console.log(
    `tradeWrites: shard=${shardIndex}/${shardCount} target=${targetOpsPerSecond} ops/sec duration=${testTimeSeconds}s max_in_flight=${maxInFlight} positions=${positions.length} accounts=${positionAccountIds.length}`
  );

  await new Promise<void>((resolve) => {
    const startWrite = () => {
      const requestStartedAt = performance.now();
      const position = choose(positions, random);
      const security = securityById.get(position.security_id)!;
      touchedPositions.add(`${position.account_id}|${position.security_no}|${position.acct_type_code}`);
      const transactionId = `${runId}-${++sequence}`;
      const transaction = transactionForPosition(
        position,
        transactionId,
        tradeDate,
        tradeDateEpoch,
        payload
      );

      counters.started += 1;
      counters.inFlight += 1;
      counters.peakInFlight = Math.max(counters.peakInFlight, counters.inFlight);

      void getRedisClient()
        .then((client) => applyTransaction(client, transaction, security))
        .then((result) => {
          if (result.status === "inserted") {
            counters.inserted += 1;
            if (performance.now() <= measurementEndsAt) counters.insertedDuringWindow += 1;
            if (
              correctnessSampleEvery > 0 &&
              counters.inserted % correctnessSampleEvery === 0
            ) {
              startCorrectnessValidation({
                result,
                transaction,
                counters,
                latencyHistogram: validationLatencyHistogram,
                errors: validationErrors
              });
            }
          } else {
            counters.duplicates += 1;
          }
        })
        .catch(() => {
          counters.errors += 1;
        })
        .finally(() => {
          counters.inFlight -= 1;
          counters.completed += 1;
          recordLatency(latencyHistogram, performance.now() - requestStartedAt);
        });
    };

    const pump = () => {
      const elapsedMs = Math.min(performance.now() - startedAt, durationMs);
      const expectedSlots = Math.min(targetOperations, Math.floor((elapsedMs * targetOpsPerSecond) / 1_000));
      const due = expectedSlots - handledSlots;
      handledSlots = expectedSlots;

      const launchCount = Math.min(due, Math.max(0, maxInFlight - counters.inFlight));
      counters.dropped += due - launchCount;
      for (let index = 0; index < launchCount; index += 1) startWrite();

      if (elapsedMs >= durationMs) {
        clearInterval(timer);
        resolve();
      }
    };

    const timer = setInterval(pump, schedulerTickMs);
    pump();
  });

  const drainStartedAt = performance.now();
  while (counters.inFlight > 0 && performance.now() - drainStartedAt < drainTimeoutMs) {
    await sleep(25);
  }
  const validationDrainStartedAt = performance.now();
  while (
    counters.validationsInFlight > 0 &&
    performance.now() - validationDrainStartedAt < drainTimeoutMs
  ) {
    await sleep(25);
  }

  const finishedAt = performance.now();
  const result = {
    pattern: "tradeWrites",
    target_ops_per_second: targetOpsPerSecond,
    achieved_ops_per_second: round(counters.insertedDuringWindow / testTimeSeconds),
    offered_ops_per_second: round(counters.started / testTimeSeconds),
    test_time_seconds: testTimeSeconds,
    wall_time_seconds: round((finishedAt - startedAt) / 1_000),
    target_operations: targetOperations,
    started_operations: counters.started,
    completed_operations: counters.completed,
    inserted_operations: counters.inserted,
    inserted_operations_during_window: counters.insertedDuringWindow,
    duplicate_operations: counters.duplicates,
    dropped_operations: counters.dropped,
    errors: counters.errors,
    correctness: {
      sample_every: correctnessSampleEvery,
      validations_started: counters.validationsStarted,
      validations_passed: counters.validationsPassed,
      validations_failed: counters.validationsFailed,
      validations_in_flight: counters.validationsInFlight,
      latency_ms: {
        p50: percentile(validationLatencyHistogram, counters.validationsStarted, 0.5),
        p95: percentile(validationLatencyHistogram, counters.validationsStarted, 0.95),
        p99: percentile(validationLatencyHistogram, counters.validationsStarted, 0.99)
      },
      errors: validationErrors
    },
    peak_in_flight: counters.peakInFlight,
    position_sample_pool_size: positions.length,
    global_account_sample_pool_size: samplePoolSize,
    distinct_account_slots: positionAccountIds.length,
    distinct_position_keys: touchedPositions.size,
    random_seed: randomSeed,
    generator_shard: {
      index: shardIndex,
      count: shardCount,
      host: process.env.TRADE_GENERATOR_HOST ?? process.env.HOSTNAME
    },
    latency_ms: {
      p50: percentile(latencyHistogram, counters.completed, 0.5),
      p95: percentile(latencyHistogram, counters.completed, 0.95),
      p99: percentile(latencyHistogram, counters.completed, 0.99),
      p99_9: percentile(latencyHistogram, counters.completed, 0.999)
    },
    ...(process.env.TRADE_EXPORT_LATENCY_HISTOGRAM === "1"
      ? { latency_histogram_ms: sparseHistogram(latencyHistogram) }
      : {})
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/trade-writes.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
  const { latency_histogram_ms: _latencyHistogram, ...consoleResult } = result;
  console.log(JSON.stringify(consoleResult, null, 2));
  console.log(`Wrote ${outputPath}`);

  await closeRedisClient();
  if (
    counters.errors > 0 ||
    counters.duplicates > 0 ||
    counters.dropped > 0 ||
    counters.inFlight > 0 ||
    counters.validationsFailed > 0 ||
    counters.validationsInFlight > 0
  ) {
    process.exitCode = 1;
  }
}

function startCorrectnessValidation({
  result,
  transaction,
  counters,
  latencyHistogram,
  errors
}: {
  result: ApplyTransactionResult;
  transaction: TransactionRow;
  counters: Counters;
  latencyHistogram: Uint32Array;
  errors: string[];
}): void {
  const startedAt = performance.now();
  counters.validationsStarted += 1;
  counters.validationsInFlight += 1;
  void getRedisClient()
    .then(async (client) => {
      type SnapshotValidation = Pick<
        AccountSnapshot,
        "revision" | "transaction_count" | "recent_transactions" | "positions"
      >;
      const [storedTransaction, storedPosition, snapshot] = await Promise.all([
        jsonGet<TransactionRow>(client, result.transaction_key),
        jsonGet<PositionRow>(client, result.position_key),
        jsonGetFields<SnapshotValidation>(client, result.snapshot_key, [
          "revision",
          "transaction_count",
          "recent_transactions",
          "positions"
        ])
      ]);
      if (!storedTransaction || storedTransaction.transaction_id !== transaction.transaction_id) {
        throw new Error(`transaction ${transaction.transaction_id} is not immediately readable`);
      }
      if (!storedPosition || !result.position_projection) {
        throw new Error(`position ${result.position_key} is not immediately readable`);
      }
      if (
        storedPosition.projection_version <
        result.position_projection.projection_version
      ) {
        throw new Error(
          `position ${result.position_key} projection version regressed`
        );
      }
      if (!snapshot || snapshot.revision < result.projection_revision) {
        throw new Error(`snapshot ${result.snapshot_key} revision regressed`);
      }
      const snapshotPosition = snapshot.positions.find(
        (position) => position._id === result.position_projection?._id
      );
      if (
        !snapshotPosition ||
        snapshotPosition.projection_version <
          result.position_projection.projection_version
      ) {
        throw new Error(
          `snapshot ${result.snapshot_key} does not contain the committed position projection`
        );
      }
      const newerWrites = snapshot.revision - result.projection_revision;
      if (
        newerWrites < snapshot.recent_transactions.length &&
        !snapshot.recent_transactions.some(
          (entry) => entry.transaction_id === transaction.transaction_id
        )
      ) {
        throw new Error(
          `snapshot ${result.snapshot_key} does not contain the committed recent transaction`
        );
      }
      if (snapshot.transaction_count < result.projection_revision) {
        throw new Error(`snapshot ${result.snapshot_key} transaction count regressed`);
      }
      counters.validationsPassed += 1;
    })
    .catch((error) => {
      counters.validationsFailed += 1;
      if (errors.length < 20) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    })
    .finally(() => {
      counters.validationsInFlight -= 1;
      recordLatency(latencyHistogram, performance.now() - startedAt);
    });
}

async function loadPositionsForAccounts(
  client: RedisConnection,
  accountIds: string[],
  concurrency: number
): Promise<PositionSample[]> {
  const positions = new Array<PositionSample | undefined>(accountIds.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < accountIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const result = await searchProjected<PositionSample>(
        client,
        INDEXES.positions,
        tagEquals("account_id", accountIds[index]),
        TRADE_POSITION_FIELDS,
        { limit: 1 }
      );
      positions[index] = result.rows[0];
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(accountIds.length, Math.max(1, concurrency)) }, () => worker())
  );
  const missingIndex = positions.findIndex((position) => !position);
  if (missingIndex >= 0) {
    throw new Error(`No position found for sampled account ${accountIds[missingIndex]}`);
  }
  return positions as PositionSample[];
}

function choose<T>(values: T[], random: () => number): T {
  const index = Math.min(values.length - 1, Math.floor(random() * values.length));
  return values[Math.max(0, index)];
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForScheduledStart(): Promise<void> {
  const value = process.env.LOAD_TEST_START_AT_EPOCH_MS;
  if (!value) return;
  const startAt = Number(value);
  if (!Number.isFinite(startAt)) throw new Error("LOAD_TEST_START_AT_EPOCH_MS must be an epoch timestamp");
  const waitMs = startAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

function recordLatency(histogram: Uint32Array, latencyMs: number): void {
  const bucket = Math.min(histogram.length - 1, Math.max(0, Math.ceil(latencyMs)));
  histogram[bucket] += 1;
}

function percentile(histogram: Uint32Array, total: number, quantile: number): number {
  if (total === 0) return 0;
  const target = Math.ceil(total * quantile);
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return index;
  }
  return histogram.length - 1;
}

function sparseHistogram(histogram: Uint32Array): Array<[number, number]> {
  const values: Array<[number, number]> = [];
  for (let index = 0; index < histogram.length; index += 1) {
    if (histogram[index] > 0) values.push([index, histogram[index]]);
  }
  return values;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  console.error(error);
  await closeRedisClient().catch(() => undefined);
  process.exitCode = 1;
});
