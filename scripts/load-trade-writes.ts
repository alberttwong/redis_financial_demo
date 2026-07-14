import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createSeededRandom, loadBenchmarkSamplePool } from "../src/lib/benchmark-samples";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { transactionForPosition } from "../src/lib/trade-load";
import { applyTransaction } from "../src/lib/transaction-writes";
import type { PositionSample } from "../src/lib/benchmark-samples";

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
};

async function main() {
  const targetOpsPerSecond = readPositiveNumber(
    "TRADE_TARGET_RPS",
    readPositiveNumber("MEMTIER_TRADE_TARGET_RPS", 30_000)
  );
  const testTimeSeconds = readPositiveNumber("TRADE_TEST_TIME", readPositiveNumber("MEMTIER_TEST_TIME", 60));
  const schedulerTickMs = readPositiveNumber("TRADE_SCHEDULER_TICK_MS", 10);
  const maxInFlight = readPositiveNumber("TRADE_MAX_IN_FLIGHT", 10_000);
  const drainTimeoutMs = readPositiveNumber("TRADE_DRAIN_TIMEOUT_MS", 30_000);
  const samplePoolSize = readPositiveNumber("TRADE_SAMPLE_POOL_SIZE", 1_000);
  const randomSeed = readPositiveNumber("TRADE_RANDOM_SEED", 20_260_714);
  const tradePayloadBytes = readPositiveNumber("MEMTIER_TRADE_PAYLOAD_BYTES", 1_024);
  const tradeDate = process.env.MEMTIER_TRADE_DATE ?? new Date().toISOString().slice(0, 10);
  const tradeDateEpoch = Date.parse(`${tradeDate}T00:00:00.000Z`);
  if (!Number.isFinite(tradeDateEpoch)) throw new Error("MEMTIER_TRADE_DATE must use YYYY-MM-DD format");

  const bootstrapClient = await getRedisClient();
  const samplePool = await loadBenchmarkSamplePool(bootstrapClient, samplePoolSize);
  const positions = uniquePositions(samplePool.positions);
  const random = createSeededRandom(randomSeed);
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
    peakInFlight: 0
  };
  const requestTimeoutMs = Math.max(drainTimeoutMs, 30_000);
  const latencyHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
  const durationMs = testTimeSeconds * 1_000;
  const targetOperations = Math.floor(targetOpsPerSecond * testTimeSeconds);
  const startedAt = performance.now();
  const measurementEndsAt = startedAt + durationMs;
  let handledSlots = 0;
  let sequence = 0;
  const touchedPositions = new Set<string>();

  console.log(
    `tradeWrites: target=${targetOpsPerSecond} ops/sec duration=${testTimeSeconds}s max_in_flight=${maxInFlight} positions=${positions.length}`
  );

  await new Promise<void>((resolve) => {
    const startWrite = () => {
      const requestStartedAt = performance.now();
      const position = choose(positions, random);
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
        .then((client) => applyTransaction(client, transaction))
        .then((result) => {
          if (result.status === "inserted") {
            counters.inserted += 1;
            if (performance.now() <= measurementEndsAt) counters.insertedDuringWindow += 1;
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
    peak_in_flight: counters.peakInFlight,
    position_sample_pool_size: positions.length,
    distinct_position_keys: touchedPositions.size,
    random_seed: randomSeed,
    latency_ms: {
      p50: percentile(latencyHistogram, counters.completed, 0.5),
      p95: percentile(latencyHistogram, counters.completed, 0.95),
      p99: percentile(latencyHistogram, counters.completed, 0.99),
      p99_9: percentile(latencyHistogram, counters.completed, 0.999)
    }
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/trade-writes.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log(`Wrote ${outputPath}`);

  await closeRedisClient();
  if (counters.errors > 0 || counters.duplicates > 0 || counters.dropped > 0 || counters.inFlight > 0) {
    process.exitCode = 1;
  }
}

function uniquePositions(positions: PositionSample[]): PositionSample[] {
  return [...new Map(positions.map((position) => [
    `${position.account_id}|${position.security_no}|${position.acct_type_code}`,
    position
  ])).values()];
}

function choose<T>(values: T[], random: () => number): T {
  const index = Math.min(values.length - 1, Math.floor(random() * values.length));
  return values[Math.max(0, index)];
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
