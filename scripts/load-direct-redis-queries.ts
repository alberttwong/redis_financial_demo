import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  createSeededRandom,
  loadBenchmarkSamplePool,
  selectQuerySample,
  type BenchmarkSamplePool,
  type QuerySample
} from "../src/lib/benchmark-samples";
import {
  DIRECT_QUERY_PATTERNS,
  directQueryTargetsForPatterns,
  parseDirectQueryPatterns,
  type DirectQueryPattern
} from "../src/lib/direct-query-benchmark";
import { disconnectRedisPool, getRedisClient } from "../src/lib/redis";
import { runQueryPattern } from "../src/lib/run-query-pattern";

type PatternCounters = {
  started: number;
  completed: number;
  succeeded: number;
  succeededDuringWindow: number;
  errors: number;
  dropped: number;
  payloadBytes: number;
  payloadBytesDuringWindow: number;
  redisCommands: number;
  redisCommandsDuringWindow: number;
  inFlight: number;
  peakInFlight: number;
};

type PatternWindow = {
  pattern: DirectQueryPattern;
  targetRps: number;
  counters: PatternCounters;
  latencyHistogram: Uint32Array;
  redisLatencyHistogram: Uint32Array;
  sampledKeys: Set<string>;
  errorCounts: Map<string, number>;
  random: () => number;
};

type DirectWindow = {
  patterns: Record<DirectQueryPattern, PatternWindow>;
  startedAt: number;
  endsAt: number;
  getInFlight: () => number;
};

async function main() {
  const totalTargetRps = readPositiveNumber("DIRECT_QUERY_TOTAL_TARGET_RPS", 30_000);
  const enabledPatterns = parseDirectQueryPatterns(process.env.DIRECT_QUERY_PATTERNS);
  const targets = directQueryTargetsForPatterns(totalTargetRps, enabledPatterns);
  const testTimeSeconds = readPositiveNumber("DIRECT_QUERY_TEST_TIME", 60);
  const warmupTimeSeconds = readNonNegativeNumber("DIRECT_QUERY_WARMUP_TIME", 10);
  const schedulerTickMs = readPositiveNumber("DIRECT_QUERY_SCHEDULER_TICK_MS", 10);
  const drainTimeoutMs = readPositiveNumber("DIRECT_QUERY_DRAIN_TIMEOUT_MS", 120_000);
  const histogramMaxMs = readPositiveInteger("DIRECT_QUERY_HISTOGRAM_MAX_MS", 120_000);
  const maxInFlight = readPositiveInteger("DIRECT_QUERY_MAX_IN_FLIGHT", 20_000);
  const samplePoolSize = readPositiveInteger("DIRECT_QUERY_SAMPLE_POOL_SIZE", 1_000);
  const randomSeed = readPositiveInteger("DIRECT_QUERY_RANDOM_SEED", 20_260_723);
  const processIndex = readPositiveInteger("DIRECT_QUERY_PROCESS_INDEX", 1);
  const processCount = readPositiveInteger("DIRECT_QUERY_PROCESS_COUNT", 1);
  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output/direct-resp";

  const client = await getRedisClient();
  const samplePool = await loadBenchmarkSamplePool(client, samplePoolSize);
  const randoms = Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [
      pattern,
      createSeededRandom(randomSeed + patternSeed(pattern))
    ])
  ) as Record<DirectQueryPattern, () => number>;

  console.log(
    `direct RESP process ${processIndex}/${processCount}: patterns=${enabledPatterns.join(",")} target=${format(totalTargetRps)}/sec warmup=${warmupTimeSeconds}s duration=${testTimeSeconds}s`
  );
  console.log(
    `sample pool: ${Object.entries(samplePool)
      .map(([name, values]) => `${name}=${values.length}`)
      .join(" ")}`
  );

  await waitForScheduledStart();
  if (warmupTimeSeconds > 0) {
    const warmup = await runWindow({
      durationSeconds: warmupTimeSeconds,
      targets,
      samplePool,
      randoms,
      enabledPatterns,
      maxInFlight,
      schedulerTickMs,
      histogramMaxMs
    });
    if (!(await waitForDrain(warmup.getInFlight, drainTimeoutMs))) {
      throw new Error(`Direct RESP warm-up did not drain within ${drainTimeoutMs}ms.`);
    }
  }

  const cpuStarted = process.cpuUsage();
  const resourceStarted = process.resourceUsage();
  const eventLoopStarted = performance.eventLoopUtilization();
  const measurement = await runWindow({
    durationSeconds: testTimeSeconds,
    targets,
    samplePool,
    randoms,
    enabledPatterns,
    maxInFlight,
    schedulerTickMs,
    histogramMaxMs
  });
  const drained = await waitForDrain(measurement.getInFlight, drainTimeoutMs);
  const finishedAt = performance.now();
  const cpu = process.cpuUsage(cpuStarted);
  const resources = process.resourceUsage();
  const eventLoop = performance.eventLoopUtilization(eventLoopStarted);

  const queries = enabledPatterns.map((pattern) =>
    summarizePattern(measurement.patterns[pattern], testTimeSeconds)
  );
  const achievedPerSecond = round(
    queries.reduce((total, query) => total + query.achieved_per_second, 0)
  );
  const achievedRedisOpsPerSecond = round(
    queries.reduce((total, query) => total + query.achieved_redis_ops_per_second, 0)
  );
  const payloadMiBPerSecond = round(
    queries.reduce((total, query) => total + query.payload_mebibytes_per_second, 0)
  );
  const droppedRequests = queries.reduce((total, query) => total + query.dropped_requests, 0);
  const errors = queries.reduce((total, query) => total + query.errors, 0);
  const wallTimeSeconds = (finishedAt - measurement.startedAt) / 1_000;
  const summary = {
    experiment: "direct-redis-resp",
    architecture: "load-generator -> Redis Cloud OSS Cluster API",
    transport: "RESP over the configured Redis connection",
    generator: {
      host: process.env.DIRECT_QUERY_GENERATOR_HOST ?? process.env.HOSTNAME ?? "unknown",
      process_index: processIndex,
      process_count: processCount,
      redis_pool_size: readPositiveInteger("REDIS_POOL_SIZE", 1)
    },
    query_patterns: enabledPatterns,
    random_seed: randomSeed,
    sample_pool_size: Object.fromEntries(
      Object.entries(samplePool).map(([name, values]) => [name, values.length])
    ),
    target_per_second: totalTargetRps,
    achieved_per_second: achievedPerSecond,
    achieved_redis_ops_per_second: achievedRedisOpsPerSecond,
    payload_mebibytes_per_second: payloadMiBPerSecond,
    test_time_seconds: testTimeSeconds,
    warmup_time_seconds: warmupTimeSeconds,
    wall_time_seconds: round(wallTimeSeconds),
    drained,
    dropped_requests: droppedRequests,
    errors,
    client_runtime: {
      cpu_user_seconds: round(cpu.user / 1_000_000),
      cpu_system_seconds: round(cpu.system / 1_000_000),
      cpu_core_equivalents: round((cpu.user + cpu.system) / 1_000_000 / wallTimeSeconds),
      event_loop_utilization: round(eventLoop.utilization),
      max_rss_delta_kib: Math.max(0, resources.maxRSS - resourceStarted.maxRSS),
      voluntary_context_switches:
        resources.voluntaryContextSwitches - resourceStarted.voluntaryContextSwitches,
      involuntary_context_switches:
        resources.involuntaryContextSwitches - resourceStarted.involuntaryContextSwitches
    },
    queries
  };

  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/direct-query-summary.json`;
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${outputPath}`);

  if (
    readBoolean("DIRECT_QUERY_FAIL_ON_LIMITS", false) &&
    (!drained || droppedRequests > 0 || errors > 0)
  ) {
    process.exitCode = 1;
  }
}

async function runWindow({
  durationSeconds,
  targets,
  samplePool,
  randoms,
  enabledPatterns,
  maxInFlight,
  schedulerTickMs,
  histogramMaxMs
}: {
  durationSeconds: number;
  targets: Record<DirectQueryPattern, number>;
  samplePool: BenchmarkSamplePool;
  randoms: Record<DirectQueryPattern, () => number>;
  enabledPatterns: readonly DirectQueryPattern[];
  maxInFlight: number;
  schedulerTickMs: number;
  histogramMaxMs: number;
}): Promise<DirectWindow> {
  let totalInFlight = 0;
  const startedAt = performance.now();
  const endsAt = startedAt + durationSeconds * 1_000;
  const patterns = Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [
      pattern,
      createPatternWindow(pattern, targets[pattern], histogramMaxMs, randoms[pattern])
    ])
  ) as Record<DirectQueryPattern, PatternWindow>;
  const totalTargetRps = Object.values(targets).reduce(
    (total, targetRps) => total + targetRps,
    0
  );
  const patternInFlightLimits = Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [
      pattern,
      targets[pattern] > 0
        ? Math.max(1, Math.floor((maxInFlight * targets[pattern]) / totalTargetRps))
        : 0
    ])
  ) as Record<DirectQueryPattern, number>;

  const startRequest = (state: PatternWindow) => {
    const sample = selectQuerySample(samplePool, state.pattern, state.random);
    state.sampledKeys.add(sampleIdentity(state.pattern, sample));
    state.counters.started += 1;
    state.counters.inFlight += 1;
    totalInFlight += 1;
    state.counters.peakInFlight = Math.max(
      state.counters.peakInFlight,
      state.counters.inFlight
    );
    const requestStartedAt = performance.now();

    void (async () => {
      try {
        const redisClient = await getRedisClient();
        const result = await runQueryPattern(
          state.pattern,
          sample,
          requestStartedAt,
          redisClient
        );
        const completedAt = performance.now();
        const payloadBytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
        state.counters.succeeded += 1;
        state.counters.payloadBytes += payloadBytes;
        state.counters.redisCommands += result.redis_command_count;
        recordLatency(state.latencyHistogram, completedAt - requestStartedAt);
        recordLatency(state.redisLatencyHistogram, result.timing.redis_ms);
        if (completedAt <= endsAt) {
          state.counters.succeededDuringWindow += 1;
          state.counters.payloadBytesDuringWindow += payloadBytes;
          state.counters.redisCommandsDuringWindow += result.redis_command_count;
        }
      } catch (error) {
        state.counters.errors += 1;
        incrementCount(state.errorCounts, errorName(error));
        recordLatency(state.latencyHistogram, performance.now() - requestStartedAt);
      } finally {
        state.counters.completed += 1;
        state.counters.inFlight -= 1;
        totalInFlight -= 1;
      }
    })();
  };

  await Promise.all(
    enabledPatterns.map(
      (pattern) =>
        new Promise<void>((resolve) => {
          const state = patterns[pattern];
          const targetRequests = Math.floor(state.targetRps * durationSeconds);
          let handledSlots = 0;
          const pump = () => {
            const elapsedMs = Math.min(performance.now() - startedAt, durationSeconds * 1_000);
            const expectedSlots = Math.min(
              targetRequests,
              Math.floor((elapsedMs * state.targetRps) / 1_000)
            );
            const due = expectedSlots - handledSlots;
            handledSlots = expectedSlots;
            const launchCount = Math.min(
              due,
              Math.max(0, maxInFlight - totalInFlight),
              Math.max(0, patternInFlightLimits[pattern] - state.counters.inFlight)
            );
            state.counters.dropped += due - launchCount;
            for (let index = 0; index < launchCount; index += 1) startRequest(state);
            if (elapsedMs >= durationSeconds * 1_000) {
              clearInterval(timer);
              resolve();
            }
          };
          const timer = setInterval(pump, schedulerTickMs);
          pump();
        })
    )
  );

  return {
    patterns,
    startedAt,
    endsAt,
    getInFlight: () => totalInFlight
  };
}

function createPatternWindow(
  pattern: DirectQueryPattern,
  targetRps: number,
  histogramMaxMs: number,
  random: () => number
): PatternWindow {
  return {
    pattern,
    targetRps,
    counters: {
      started: 0,
      completed: 0,
      succeeded: 0,
      succeededDuringWindow: 0,
      errors: 0,
      dropped: 0,
      payloadBytes: 0,
      payloadBytesDuringWindow: 0,
      redisCommands: 0,
      redisCommandsDuringWindow: 0,
      inFlight: 0,
      peakInFlight: 0
    },
    latencyHistogram: new Uint32Array(histogramMaxMs + 2),
    redisLatencyHistogram: new Uint32Array(histogramMaxMs + 2),
    sampledKeys: new Set<string>(),
    errorCounts: new Map<string, number>(),
    random
  };
}

function summarizePattern(state: PatternWindow, testTimeSeconds: number) {
  const latency = latencySummary(state.latencyHistogram);
  const redisLatency = latencySummary(state.redisLatencyHistogram);
  return {
    pattern: state.pattern,
    target_per_second: round(state.targetRps),
    achieved_per_second: round(state.counters.succeededDuringWindow / testTimeSeconds),
    achieved_redis_ops_per_second: round(
      state.counters.redisCommandsDuringWindow / testTimeSeconds
    ),
    target_requests: Math.floor(state.targetRps * testTimeSeconds),
    started_requests: state.counters.started,
    completed_requests: state.counters.completed,
    successful_requests: state.counters.succeeded,
    successful_requests_during_window: state.counters.succeededDuringWindow,
    errors: state.counters.errors,
    error_counts: Object.fromEntries(state.errorCounts),
    dropped_requests: state.counters.dropped,
    peak_in_flight: state.counters.peakInFlight,
    distinct_sample_keys: state.sampledKeys.size,
    average_payload_bytes:
      state.counters.succeeded === 0
        ? 0
        : round(state.counters.payloadBytes / state.counters.succeeded),
    payload_mebibytes_per_second: round(
      state.counters.payloadBytesDuringWindow / 1_024 / 1_024 / testTimeSeconds
    ),
    latency_ms: latency,
    redis_latency_ms: redisLatency,
    latency_histogram_ms: sparseHistogram(state.latencyHistogram),
    redis_latency_histogram_ms: sparseHistogram(state.redisLatencyHistogram)
  };
}

function sampleIdentity(pattern: DirectQueryPattern, sample: QuerySample): string {
  switch (pattern) {
    case "accountById":
    case "positionsByAccount":
    case "transactionsByAccount":
    case "accountPortfolioJoin":
    case "accountActivityJoin":
    case "accountSnapshot":
      return sample.account_id;
    case "securityById":
      return sample.security_id;
    case "securityByNo":
      return sample.security_no;
    case "positionByComposite":
      return `${sample.account_id}|${sample.security_no}|${sample.acct_type_code}`;
    case "transactionById":
      return sample.transaction_id;
    case "transactionsBySecurity":
      return sample.security_id;
    case "transactionsByAccountSecurity":
      return `${sample.account_id}|${sample.security_id}`;
  }
}

function recordLatency(histogram: Uint32Array, latencyMs: number): void {
  const bucket = Math.min(histogram.length - 1, Math.max(0, Math.ceil(latencyMs)));
  histogram[bucket] += 1;
}

function latencySummary(histogram: Uint32Array) {
  const samples = histogram.reduce((total, count) => total + count, 0);
  return {
    samples,
    p50: percentile(histogram, samples, 0.5),
    p95: percentile(histogram, samples, 0.95),
    p99: percentile(histogram, samples, 0.99),
    p99_9: percentile(histogram, samples, 0.999)
  };
}

function percentile(histogram: Uint32Array, samples: number, quantile: number): number {
  if (samples === 0) return 0;
  const target = Math.ceil(samples * quantile);
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index];
    if (seen >= target) return index;
  }
  return histogram.length - 1;
}

function sparseHistogram(histogram: Uint32Array): Array<[number, number]> {
  const buckets: Array<[number, number]> = [];
  for (let index = 0; index < histogram.length; index += 1) {
    if (histogram[index] > 0) buckets.push([index, histogram[index]]);
  }
  return buckets;
}

function patternSeed(pattern: DirectQueryPattern): number {
  return [...pattern].reduce(
    (seed, character) => Math.imul(seed, 31) + character.charCodeAt(0),
    0
  ) >>> 0;
}

function incrementCount(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error) return error.name;
  return "unknown";
}

async function waitForScheduledStart(): Promise<void> {
  const value = process.env.LOAD_TEST_START_AT_EPOCH_MS;
  if (!value) return;
  const startAt = Number(value);
  if (!Number.isFinite(startAt)) {
    throw new Error("LOAD_TEST_START_AT_EPOCH_MS must be a Unix epoch timestamp in milliseconds.");
  }
  const waitMs = startAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

async function waitForDrain(inFlight: () => number, timeoutMs: number): Promise<boolean> {
  const startedAt = performance.now();
  while (inFlight() > 0 && performance.now() - startedAt < timeoutMs) {
    await sleep(25);
  }
  return inFlight() === 0;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be 0, 1, false, or true.`);
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const timeoutMs = readPositiveNumber("DIRECT_QUERY_DISCONNECT_TIMEOUT_MS", 5_000);
    await Promise.race([disconnectRedisPool(), sleep(timeoutMs)]);
    process.exit(process.exitCode ?? 0);
  });
