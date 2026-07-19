import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import {
  createSeededRandom,
  selectQuerySample,
  type BenchmarkSamplePool,
  type QueryPattern,
  type QuerySample
} from "../src/lib/benchmark-samples";

const QUERY_PROFILES = {
  accountById: { slug: "account-by-id", target: "default" },
  securityById: { slug: "security-by-id", target: "default" },
  securityByNo: { slug: "security-by-no", target: "default" },
  positionByComposite: { slug: "position-by-composite", target: "default" },
  positionsByAccount: { slug: "positions-by-account", target: "default" },
  transactionById: { slug: "transaction-by-id", target: "default" },
  transactionsByAccount: { slug: "transactions-by-account", target: "default" },
  transactionsBySecurity: { slug: "transactions-by-security", target: "default" },
  transactionsByAccountSecurity: { slug: "transactions-by-account-security", target: "default" },
  accountPortfolioJoin: { slug: "account-portfolio-join", target: "join" },
  accountActivityJoin: { slug: "account-activity-join", target: "join" },
  accountSnapshot: { slug: "account-snapshot", target: "default" }
} as const satisfies Partial<Record<QueryPattern, { slug: string; target: "default" | "join" }>>;

type LoadQueryPattern = keyof typeof QUERY_PROFILES;

type Counters = {
  started: number;
  completed: number;
  succeeded: number;
  succeededDuringWindow: number;
  httpErrors: number;
  requestErrors: number;
  dropped: number;
  responseBytes: number;
  successfulResponseBytes: number;
  successfulResponseBytesDuringWindow: number;
  httpErrorResponseBytes: number;
  apiPayloadBytes: number;
  apiPayloadBytesDuringWindow: number;
  redisCommands: number;
  redisCommandsDuringWindow: number;
  inFlight: number;
  peakInFlight: number;
};

type LoadWindow = {
  counters: Counters;
  latencyHistogram: Uint32Array;
  socketQueueHistogram: Uint32Array;
  connectionSetupHistogram: Uint32Array;
  timeToFirstByteHistogram: Uint32Array;
  sampledKeys: Set<string>;
  httpStatusCounts: Map<string, number>;
  requestErrorCounts: Map<string, number>;
  startedAt: number;
  endsAt: number;
};

async function main() {
  const pattern = process.argv[2];
  if (!isLoadQueryPattern(pattern)) {
    throw new Error(`Query pattern must be one of: ${Object.keys(QUERY_PROFILES).join(", ")}`);
  }

  const profile = QUERY_PROFILES[pattern];
  const baseUrl = new URL(
    process.env.QUERY_BASE_URL ?? `http://127.0.0.1:${process.env.AWS_LOAD_RUNNER_WEB_PORT ?? "3000"}`
  );
  const testTimeSeconds = readPositiveNumber(
    "QUERY_TEST_TIME",
    readPositiveNumber("MEMTIER_TEST_TIME", 60)
  );
  const warmupTimeSeconds = readNonNegativeNumber("QUERY_WARMUP_TIME", 0);
  const targetRps =
    profile.target === "join"
      ? readPositiveNumber("QUERY_JOIN_TARGET_RPS", 45_000)
      : readPositiveNumber("QUERY_DEFAULT_TARGET_RPS", 9_000);
  const schedulerTickMs = readPositiveNumber("QUERY_SCHEDULER_TICK_MS", 10);
  const requestTimeoutMs = readPositiveNumber("QUERY_REQUEST_TIMEOUT_MS", 30_000);
  const socketTimeoutMs = readPositiveNumber("QUERY_SOCKET_TIMEOUT_MS", requestTimeoutMs);
  const acceptEncoding = process.env.QUERY_ACCEPT_ENCODING?.trim();
  const drainTimeoutMs = readPositiveNumber("QUERY_DRAIN_TIMEOUT_MS", 30_000);
  const maxInFlight = readPositiveNumber("QUERY_MAX_IN_FLIGHT", 10_000);

  const samplePoolSize = readPositiveNumber("QUERY_SAMPLE_POOL_SIZE", 1_000);
  const samplePool = await loadSamplePool(baseUrl, samplePoolSize);
  const randomSeed = readPositiveNumber("QUERY_RANDOM_SEED", 20_260_714) + patternSeed(pattern);
  const random = createSeededRandom(randomSeed);
  await waitForScheduledStart();
  const transport = baseUrl.protocol === "https:" ? https : http;
  const Agent = baseUrl.protocol === "https:" ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: true,
    maxSockets: readPositiveNumber("QUERY_MAX_SOCKETS", maxInFlight),
    maxFreeSockets: readPositiveNumber("QUERY_MAX_FREE_SOCKETS", Math.min(maxInFlight, 256))
  });
  let totalInFlight = 0;

  console.log(
    `${pattern}: target=${targetRps} requests/sec warmup=${warmupTimeSeconds}s duration=${testTimeSeconds}s max_in_flight=${maxInFlight}`
  );

  const runWindow = async (durationSeconds: number): Promise<LoadWindow> => {
    const counters = createCounters();
    const latencyHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
    const socketQueueHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
    const connectionSetupHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
    const timeToFirstByteHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
    const sampledKeys = new Set<string>();
    const httpStatusCounts = new Map<string, number>();
    const requestErrorCounts = new Map<string, number>();
    const durationMs = durationSeconds * 1000;
    const targetRequests = Math.floor(targetRps * durationSeconds);
    const startedAt = performance.now();
    const endsAt = startedAt + durationMs;
    let handledSlots = 0;

    await new Promise<void>((resolve) => {
      const startRequest = () => {
        const sample = selectQuerySample(samplePool, pattern, random);
        sampledKeys.add(sampleIdentity(pattern, sample));
        const queryUrl = makeQueryUrl(baseUrl, pattern, sample);
        counters.started += 1;
        counters.inFlight += 1;
        totalInFlight += 1;
        counters.peakInFlight = Math.max(counters.peakInFlight, counters.inFlight);
        const requestStartedAt = performance.now();
        let finished = false;
        let deadlineTimer: NodeJS.Timeout | undefined;

        const finish = (
          statusCode?: number,
          bytes = 0,
          redisCommands = 0,
          apiPayloadBytes = 0,
          requestError?: unknown
        ) => {
          if (finished) return;
          finished = true;
          if (deadlineTimer) clearTimeout(deadlineTimer);
          const completedAt = performance.now();
          counters.inFlight -= 1;
          totalInFlight -= 1;
          counters.completed += 1;
          counters.responseBytes += bytes;
          if (statusCode !== undefined) incrementCount(httpStatusCounts, String(statusCode));
          if (requestError !== undefined) {
            counters.requestErrors += 1;
            incrementCount(requestErrorCounts, requestErrorName(requestError));
          } else if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
            counters.succeeded += 1;
            counters.successfulResponseBytes += bytes;
            counters.apiPayloadBytes += apiPayloadBytes;
            counters.redisCommands += redisCommands;
            if (completedAt <= endsAt) {
              counters.succeededDuringWindow += 1;
              counters.successfulResponseBytesDuringWindow += bytes;
              counters.apiPayloadBytesDuringWindow += apiPayloadBytes;
              counters.redisCommandsDuringWindow += redisCommands;
            }
          } else {
            counters.httpErrors += 1;
            counters.httpErrorResponseBytes += bytes;
          }
          recordLatency(latencyHistogram, completedAt - requestStartedAt);
        };

        const request = transport.request(
          queryUrl,
          {
            agent,
            headers: {
              accept: "application/json",
              "cache-control": "no-store",
              ...(acceptEncoding ? { "accept-encoding": acceptEncoding } : {})
            },
            method: "GET"
          },
          (response) => {
            let bytes = 0;
            recordLatency(timeToFirstByteHistogram, performance.now() - requestStartedAt);
            const redisCommands = positiveHeaderNumber(response.headers["x-redis-command-count"]);
            const apiPayloadBytes = nonNegativeHeaderNumber(response.headers["x-query-payload-bytes"]);
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
            });
            response.on("end", () => finish(response.statusCode, bytes, redisCommands, apiPayloadBytes));
            response.on("error", (error) =>
              finish(response.statusCode, bytes, redisCommands, apiPayloadBytes, error)
            );
          }
        );
        request.once("socket", (socket) => {
          const socketAssignedAt = performance.now();
          recordLatency(socketQueueHistogram, socketAssignedAt - requestStartedAt);
          if (socket.connecting) {
            socket.once("connect", () =>
              recordLatency(connectionSetupHistogram, performance.now() - socketAssignedAt)
            );
          } else {
            recordLatency(connectionSetupHistogram, 0);
          }
        });
        deadlineTimer = setTimeout(
          () => request.destroy(new Error("wall clock request timeout")),
          requestTimeoutMs
        );
        request.setTimeout(socketTimeoutMs, () => request.destroy(new Error("socket inactivity timeout")));
        request.on("error", (error) => finish(undefined, 0, 0, 0, error));
        request.end();
      };

      const pump = () => {
        const elapsedMs = Math.min(performance.now() - startedAt, durationMs);
        const expectedSlots = Math.min(targetRequests, Math.floor((elapsedMs * targetRps) / 1000));
        const due = expectedSlots - handledSlots;
        handledSlots = expectedSlots;

        const launchCount = Math.min(due, Math.max(0, maxInFlight - totalInFlight));
        counters.dropped += due - launchCount;
        for (let index = 0; index < launchCount; index += 1) {
          startRequest();
        }

        if (elapsedMs >= durationMs) {
          clearInterval(timer);
          resolve();
        }
      };

      const timer = setInterval(pump, schedulerTickMs);
      pump();
    });

    return {
      counters,
      latencyHistogram,
      socketQueueHistogram,
      connectionSetupHistogram,
      timeToFirstByteHistogram,
      sampledKeys,
      httpStatusCounts,
      requestErrorCounts,
      startedAt,
      endsAt
    };
  };

  const warmupWindow = warmupTimeSeconds > 0 ? await runWindow(warmupTimeSeconds) : undefined;
  if (warmupWindow && !(await waitForDrain(() => totalInFlight, drainTimeoutMs))) {
    agent.destroy();
    throw new Error(`Warm-up requests did not drain within ${drainTimeoutMs}ms.`);
  }
  const measurementWindow = await runWindow(testTimeSeconds);
  const {
    counters,
    latencyHistogram,
    socketQueueHistogram,
    connectionSetupHistogram,
    timeToFirstByteHistogram,
    sampledKeys,
    httpStatusCounts,
    requestErrorCounts,
    startedAt
  } = measurementWindow;
  const targetRequests = Math.floor(targetRps * testTimeSeconds);

  if (!(await waitForDrain(() => totalInFlight, drainTimeoutMs))) {
    agent.destroy();
    const destroyStartedAt = performance.now();
    while (totalInFlight > 0 && performance.now() - destroyStartedAt < 5_000) {
      await sleep(25);
    }
  } else {
    agent.destroy();
  }

  const finishedAt = performance.now();
  const redisCommandsPerSuccessfulRequest =
    counters.succeeded === 0 ? 0 : counters.redisCommands / counters.succeeded;
  const result = {
    pattern,
    accept_encoding: acceptEncoding ?? "identity",
    random_seed: randomSeed,
    ...(process.env.QUERY_GENERATOR_SHARD_INDEX
      ? {
          generator_shard: {
            index: readPositiveNumber("QUERY_GENERATOR_SHARD_INDEX", 1),
            count: readPositiveNumber("QUERY_GENERATOR_SHARD_COUNT", 1),
            host: process.env.QUERY_GENERATOR_HOST ?? process.env.HOSTNAME
          }
        }
      : {}),
    sample_pool_size: Object.fromEntries(Object.entries(samplePool).map(([name, values]) => [name, values.length])),
    warmup_time_seconds: warmupTimeSeconds,
    ...(warmupWindow
      ? {
          warmup: {
            target_requests: Math.floor(targetRps * warmupTimeSeconds),
            started_requests: warmupWindow.counters.started,
            completed_requests: warmupWindow.counters.completed,
            successful_requests: warmupWindow.counters.succeeded,
            dropped_requests: warmupWindow.counters.dropped,
            http_errors: warmupWindow.counters.httpErrors,
            request_errors: warmupWindow.counters.requestErrors,
            peak_in_flight: warmupWindow.counters.peakInFlight,
            latency_ms: {
              p50: percentile(warmupWindow.latencyHistogram, warmupWindow.counters.completed, 0.5),
              p95: percentile(warmupWindow.latencyHistogram, warmupWindow.counters.completed, 0.95),
              p99: percentile(warmupWindow.latencyHistogram, warmupWindow.counters.completed, 0.99),
              p99_9: percentile(warmupWindow.latencyHistogram, warmupWindow.counters.completed, 0.999)
            }
          }
        }
      : {}),
    distinct_sample_keys: sampledKeys.size,
    target_rps: targetRps,
    achieved_rps: round(counters.succeededDuringWindow / testTimeSeconds),
    achieved_redis_ops_per_second: round(counters.redisCommandsDuringWindow / testTimeSeconds),
    estimated_target_redis_ops_per_second: round(targetRps * redisCommandsPerSuccessfulRequest),
    offered_rps: round(counters.started / testTimeSeconds),
    test_time_seconds: testTimeSeconds,
    wall_time_seconds: round((finishedAt - startedAt) / 1000),
    target_requests: targetRequests,
    started_requests: counters.started,
    completed_requests: counters.completed,
    successful_requests: counters.succeeded,
    successful_requests_during_window: counters.succeededDuringWindow,
    dropped_requests: counters.dropped,
    http_errors: counters.httpErrors,
    request_errors: counters.requestErrors,
    http_status_counts: Object.fromEntries(httpStatusCounts),
    request_error_counts: Object.fromEntries(requestErrorCounts),
    error_rate: counters.completed === 0
      ? 0
      : roundTo((counters.httpErrors + counters.requestErrors) / counters.completed, 6),
    response_bytes: counters.responseBytes,
    successful_response_bytes: counters.successfulResponseBytes,
    successful_response_bytes_during_window: counters.successfulResponseBytesDuringWindow,
    http_error_response_bytes: counters.httpErrorResponseBytes,
    api_payload_bytes: counters.apiPayloadBytes,
    api_payload_bytes_during_window: counters.apiPayloadBytesDuringWindow,
    average_successful_response_bytes:
      counters.succeeded === 0 ? 0 : round(counters.successfulResponseBytes / counters.succeeded),
    average_api_payload_bytes:
      counters.succeeded === 0 ? 0 : round(counters.apiPayloadBytes / counters.succeeded),
    redis_commands: counters.redisCommands,
    redis_commands_per_successful_request: round(redisCommandsPerSuccessfulRequest),
    response_megabytes_per_second: round(counters.responseBytes / 1024 / 1024 / testTimeSeconds),
    successful_response_megabytes_per_second: round(
      counters.successfulResponseBytesDuringWindow / 1024 / 1024 / testTimeSeconds
    ),
    api_payload_megabytes_per_second: round(
      counters.apiPayloadBytesDuringWindow / 1024 / 1024 / testTimeSeconds
    ),
    peak_in_flight: counters.peakInFlight,
    latency_ms: {
      p50: percentile(latencyHistogram, counters.completed, 0.5),
      p95: percentile(latencyHistogram, counters.completed, 0.95),
      p99: percentile(latencyHistogram, counters.completed, 0.99),
      p99_9: percentile(latencyHistogram, counters.completed, 0.999)
    },
    socket_queue_ms: latencySummary(socketQueueHistogram),
    connection_setup_ms: latencySummary(connectionSetupHistogram),
    time_to_first_byte_ms: latencySummary(timeToFirstByteHistogram),
    ...(process.env.QUERY_EXPORT_LATENCY_HISTOGRAM === "1"
      ? {
          latency_histogram_ms: sparseHistogram(latencyHistogram),
          socket_queue_histogram_ms: sparseHistogram(socketQueueHistogram),
          connection_setup_histogram_ms: sparseHistogram(connectionSetupHistogram),
          time_to_first_byte_histogram_ms: sparseHistogram(timeToFirstByteHistogram)
        }
      : {}),
    base_url: baseUrl.origin
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/query-${profile.slug}.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
  const { latency_histogram_ms: _latencyHistogram, ...consoleResult } = result;
  console.log(JSON.stringify(consoleResult, null, 2));
  console.log(`Wrote ${outputPath}`);

  if (counters.httpErrors > 0 || counters.requestErrors > 0 || counters.dropped > 0) {
    process.exitCode = 1;
  }
}

async function loadSamplePool(baseUrl: URL, count: number): Promise<BenchmarkSamplePool> {
  const timeoutMs = readPositiveNumber("QUERY_STARTUP_TIMEOUT_MS", 60_000);
  const startedAt = performance.now();
  let lastError: unknown;

  while (performance.now() - startedAt < timeoutMs) {
    try {
      const samplesUrl = new URL("/api/samples", baseUrl);
      samplesUrl.searchParams.set("count", String(Math.floor(count)));
      const response = await fetch(samplesUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(timeoutMs, 5_000))
      });
      const body = (await response.json()) as { sample_pool?: BenchmarkSamplePool; error?: string };
      if (!response.ok || !body.sample_pool || body.error) {
        throw new Error(body.error ?? `Sample endpoint returned HTTP ${response.status}`);
      }
      return body.sample_pool;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(
    `Could not load query samples from ${new URL("/api/samples", baseUrl)}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

function makeQueryUrl(baseUrl: URL, pattern: QueryPattern, samples: QuerySample): URL {
  const url = new URL("/api/query", baseUrl);
  url.search = new URLSearchParams({
    pattern,
    account_id: samples.account_id,
    security_id: samples.security_id,
    security_no: samples.security_no,
    acct_type_code: samples.acct_type_code,
    trade_date: samples.trade_date,
    transaction_id: samples.transaction_id,
    limit: "100"
  }).toString();
  return url;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createCounters(): Counters {
  return {
    started: 0,
    completed: 0,
    succeeded: 0,
    succeededDuringWindow: 0,
    httpErrors: 0,
    requestErrors: 0,
    dropped: 0,
    responseBytes: 0,
    successfulResponseBytes: 0,
    successfulResponseBytesDuringWindow: 0,
    httpErrorResponseBytes: 0,
    apiPayloadBytes: 0,
    apiPayloadBytesDuringWindow: 0,
    redisCommands: 0,
    redisCommandsDuringWindow: 0,
    inFlight: 0,
    peakInFlight: 0
  };
}

function isLoadQueryPattern(value: string | undefined): value is LoadQueryPattern {
  return value !== undefined && value in QUERY_PROFILES;
}

function patternSeed(pattern: QueryPattern): number {
  return [...pattern].reduce((seed, character) => Math.imul(seed, 31) + character.charCodeAt(0), 0) >>> 0;
}

function sampleIdentity(pattern: QueryPattern, sample: QuerySample): string {
  switch (pattern) {
    case "accountById":
    case "positionsByAccount":
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
    case "transactionsByComposite":
      return `${sample.account_id}|${sample.security_id}|${sample.trade_date}|${sample.acct_type_code}`;
    case "transactionsByAccount":
      return sample.account_id;
    case "transactionsBySecurity":
      return sample.security_id;
    case "transactionsByAccountSecurity":
      return `${sample.account_id}|${sample.security_id}`;
  }
}

function positiveHeaderNumber(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function nonNegativeHeaderNumber(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function incrementCount(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function requestErrorName(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  if (error instanceof Error && error.message === "wall clock request timeout") {
    return "wall_clock_request_timeout";
  }
  if (error instanceof Error && error.message === "socket inactivity timeout") {
    return "socket_inactivity_timeout";
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
  const buckets: Array<[number, number]> = [];
  for (let index = 0; index < histogram.length; index += 1) {
    if (histogram[index] > 0) buckets.push([index, histogram[index]]);
  }
  return buckets;
}

function latencySummary(histogram: Uint32Array) {
  const total = histogram.reduce((sum, count) => sum + count, 0);
  return {
    samples: total,
    p50: percentile(histogram, total, 0.5),
    p95: percentile(histogram, total, 0.95),
    p99: percentile(histogram, total, 0.99),
    p99_9: percentile(histogram, total, 0.999)
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
