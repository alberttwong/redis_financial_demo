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
  redisCommands: number;
  redisCommandsDuringWindow: number;
  inFlight: number;
  peakInFlight: number;
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
  const targetRps =
    profile.target === "join"
      ? readPositiveNumber("QUERY_JOIN_TARGET_RPS", 50_000)
      : readPositiveNumber("QUERY_DEFAULT_TARGET_RPS", 10_000);
  const schedulerTickMs = readPositiveNumber("QUERY_SCHEDULER_TICK_MS", 10);
  const requestTimeoutMs = readPositiveNumber("QUERY_REQUEST_TIMEOUT_MS", 30_000);
  const drainTimeoutMs = readPositiveNumber("QUERY_DRAIN_TIMEOUT_MS", 30_000);
  const maxInFlight = readPositiveNumber("QUERY_MAX_IN_FLIGHT", 2_000);

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
  const counters: Counters = {
    started: 0,
    completed: 0,
    succeeded: 0,
    succeededDuringWindow: 0,
    httpErrors: 0,
    requestErrors: 0,
    dropped: 0,
    responseBytes: 0,
    redisCommands: 0,
    redisCommandsDuringWindow: 0,
    inFlight: 0,
    peakInFlight: 0
  };
  const latencyHistogram = new Uint32Array(Math.ceil(requestTimeoutMs) + 2);
  const durationMs = testTimeSeconds * 1000;
  const targetRequests = Math.floor(targetRps * testTimeSeconds);
  const startedAt = performance.now();
  const measurementEndsAt = startedAt + durationMs;
  let handledSlots = 0;
  const sampledKeys = new Set<string>();

  console.log(
    `${pattern}: target=${targetRps} requests/sec duration=${testTimeSeconds}s max_in_flight=${maxInFlight}`
  );

  await new Promise<void>((resolve) => {
    const startRequest = () => {
      const sample = selectQuerySample(samplePool, pattern, random);
      sampledKeys.add(sampleIdentity(pattern, sample));
      const queryUrl = makeQueryUrl(baseUrl, pattern, sample);
      counters.started += 1;
      counters.inFlight += 1;
      counters.peakInFlight = Math.max(counters.peakInFlight, counters.inFlight);
      const requestStartedAt = performance.now();
      let finished = false;

      const finish = (statusCode?: number, bytes = 0, redisCommands = 0, requestFailed = false) => {
        if (finished) return;
        finished = true;
        counters.inFlight -= 1;
        counters.completed += 1;
        counters.responseBytes += bytes;
        if (requestFailed) counters.requestErrors += 1;
        else if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
          counters.succeeded += 1;
          counters.redisCommands += redisCommands;
          if (performance.now() <= measurementEndsAt) {
            counters.succeededDuringWindow += 1;
            counters.redisCommandsDuringWindow += redisCommands;
          }
        }
        else counters.httpErrors += 1;
        recordLatency(latencyHistogram, performance.now() - requestStartedAt);
      };

      const request = transport.request(
        queryUrl,
        {
          agent,
          headers: {
            accept: "application/json",
            "cache-control": "no-store"
          },
          method: "GET"
        },
        (response) => {
          let bytes = 0;
          const redisCommands = positiveHeaderNumber(response.headers["x-redis-command-count"]);
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
          response.on("end", () => finish(response.statusCode, bytes, redisCommands));
          response.on("error", () => finish(response.statusCode, bytes, redisCommands, true));
        }
      );
      request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("request timeout")));
      request.on("error", () => finish(undefined, 0, 0, true));
      request.end();
    };

    const pump = () => {
      const elapsedMs = Math.min(performance.now() - startedAt, durationMs);
      const expectedSlots = Math.min(targetRequests, Math.floor((elapsedMs * targetRps) / 1000));
      const due = expectedSlots - handledSlots;
      handledSlots = expectedSlots;

      const launchCount = Math.min(due, Math.max(0, maxInFlight - counters.inFlight));
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

  const drainStartedAt = performance.now();
  while (counters.inFlight > 0 && performance.now() - drainStartedAt < drainTimeoutMs) {
    await sleep(25);
  }
  if (counters.inFlight > 0) {
    agent.destroy();
    const destroyStartedAt = performance.now();
    while (counters.inFlight > 0 && performance.now() - destroyStartedAt < 5_000) {
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
    random_seed: randomSeed,
    sample_pool_size: Object.fromEntries(Object.entries(samplePool).map(([name, values]) => [name, values.length])),
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
    error_rate: counters.completed === 0 ? 0 : round((counters.httpErrors + counters.requestErrors) / counters.completed),
    response_bytes: counters.responseBytes,
    redis_commands: counters.redisCommands,
    redis_commands_per_successful_request: round(redisCommandsPerSuccessfulRequest),
    response_megabytes_per_second: round(counters.responseBytes / 1024 / 1024 / testTimeSeconds),
    peak_in_flight: counters.peakInFlight,
    latency_ms: {
      p50: percentile(latencyHistogram, counters.completed, 0.5),
      p95: percentile(latencyHistogram, counters.completed, 0.95),
      p99: percentile(latencyHistogram, counters.completed, 0.99),
      p99_9: percentile(latencyHistogram, counters.completed, 0.999)
    },
    base_url: baseUrl.origin
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/query-${profile.slug}.json`;
  await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
