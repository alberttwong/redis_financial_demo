import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DIRECT_QUERY_PATTERNS,
  type DirectQueryPattern
} from "../src/lib/direct-query-benchmark";

type SparseHistogram = Array<[number, number]>;

type ProcessQuery = {
  pattern: DirectQueryPattern;
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  successful_requests: number;
  successful_requests_during_window: number;
  errors: number;
  dropped_requests: number;
  distinct_sample_keys: number;
  average_payload_bytes: number;
  payload_mebibytes_per_second: number;
  latency_histogram_ms: SparseHistogram;
  redis_latency_histogram_ms: SparseHistogram;
};

type ProcessSummary = {
  experiment: string;
  generator: { host: string; process_index: number; process_count: number };
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  payload_mebibytes_per_second: number;
  test_time_seconds: number;
  warmup_time_seconds: number;
  drained: boolean;
  dropped_requests: number;
  errors: number;
  client_runtime: {
    cpu_core_equivalents: number;
    event_loop_utilization: number;
  };
  queries: ProcessQuery[];
};

type AggregateState = {
  targetPerSecond: number;
  achievedPerSecond: number;
  achievedRedisOpsPerSecond: number;
  successfulRequests: number;
  successfulRequestsDuringWindow: number;
  errors: number;
  droppedRequests: number;
  payloadBytesWeighted: number;
  payloadMiBPerSecond: number;
  distinctSampleKeys: number[];
  latencyHistogram: Map<number, number>;
  redisLatencyHistogram: Map<number, number>;
};

async function main() {
  const rootDirectory = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2]) {
    throw new Error("Usage: aggregate-direct-redis-results.ts <result-directory>");
  }
  const paths = (await findFiles(rootDirectory, "direct-query-summary.json")).sort();
  if (paths.length === 0) {
    throw new Error(`No direct-query-summary.json files found under ${rootDirectory}`);
  }
  const processes = await Promise.all(
    paths.map(async (resultPath) => {
      const parsed = JSON.parse(await readFile(resultPath, "utf8")) as ProcessSummary;
      if (parsed.experiment !== "direct-redis-resp") {
        throw new Error(`${resultPath} is not a direct Redis RESP result.`);
      }
      return { resultPath, parsed };
    })
  );
  const testTimes = new Set(processes.map(({ parsed }) => parsed.test_time_seconds));
  const warmupTimes = new Set(processes.map(({ parsed }) => parsed.warmup_time_seconds));
  if (testTimes.size !== 1 || warmupTimes.size !== 1) {
    throw new Error("Direct Redis process results do not use the same test and warm-up durations.");
  }

  const states = Object.fromEntries(
    DIRECT_QUERY_PATTERNS.map((pattern) => [pattern, createState()])
  ) as Record<DirectQueryPattern, AggregateState>;
  for (const { parsed } of processes) {
    for (const query of parsed.queries) {
      const state = states[query.pattern];
      state.targetPerSecond += query.target_per_second;
      state.achievedPerSecond += query.achieved_per_second;
      state.achievedRedisOpsPerSecond += query.achieved_redis_ops_per_second;
      state.successfulRequests += query.successful_requests;
      state.successfulRequestsDuringWindow += query.successful_requests_during_window;
      state.errors += query.errors;
      state.droppedRequests += query.dropped_requests;
      state.payloadBytesWeighted += query.average_payload_bytes * query.successful_requests;
      state.payloadMiBPerSecond += query.payload_mebibytes_per_second;
      state.distinctSampleKeys.push(query.distinct_sample_keys);
      mergeHistogram(state.latencyHistogram, query.latency_histogram_ms);
      mergeHistogram(state.redisLatencyHistogram, query.redis_latency_histogram_ms);
    }
  }

  const queries = DIRECT_QUERY_PATTERNS.filter(
    (pattern) => states[pattern].targetPerSecond > 0
  ).map((pattern) => {
    const state = states[pattern];
    return {
      pattern,
      target_per_second: round(state.targetPerSecond),
      achieved_per_second: round(state.achievedPerSecond),
      achievement_ratio:
        state.targetPerSecond === 0 ? 0 : round(state.achievedPerSecond / state.targetPerSecond),
      achieved_redis_ops_per_second: round(state.achievedRedisOpsPerSecond),
      p50_latency_ms: percentile(state.latencyHistogram, 0.5),
      p95_latency_ms: percentile(state.latencyHistogram, 0.95),
      p99_latency_ms: percentile(state.latencyHistogram, 0.99),
      redis_p50_latency_ms: percentile(state.redisLatencyHistogram, 0.5),
      redis_p95_latency_ms: percentile(state.redisLatencyHistogram, 0.95),
      redis_p99_latency_ms: percentile(state.redisLatencyHistogram, 0.99),
      errors: state.errors,
      dropped_requests: state.droppedRequests,
      average_payload_bytes:
        state.successfulRequests === 0
          ? 0
          : round(state.payloadBytesWeighted / state.successfulRequests),
      payload_mebibytes_per_second: round(state.payloadMiBPerSecond),
      distinct_sample_keys_min:
        state.distinctSampleKeys.length === 0 ? 0 : Math.min(...state.distinctSampleKeys),
      distinct_sample_keys_max:
        state.distinctSampleKeys.length === 0 ? 0 : Math.max(...state.distinctSampleKeys)
    };
  });
  const summary = {
    experiment: "distributed-direct-redis-resp",
    architecture: "AWS direct load generators -> Redis Cloud OSS Cluster API",
    generated_at: new Date().toISOString(),
    generator_processes: processes.length,
    generator_hosts: new Set(processes.map(({ parsed }) => parsed.generator.host)).size,
    test_time_seconds: processes[0].parsed.test_time_seconds,
    warmup_time_seconds: processes[0].parsed.warmup_time_seconds,
    target_per_second: round(queries.reduce((total, query) => total + query.target_per_second, 0)),
    achieved_per_second: round(
      queries.reduce((total, query) => total + query.achieved_per_second, 0)
    ),
    achieved_redis_ops_per_second: round(
      queries.reduce((total, query) => total + query.achieved_redis_ops_per_second, 0)
    ),
    payload_mebibytes_per_second: round(
      queries.reduce((total, query) => total + query.payload_mebibytes_per_second, 0)
    ),
    dropped_requests: queries.reduce((total, query) => total + query.dropped_requests, 0),
    errors: queries.reduce((total, query) => total + query.errors, 0),
    all_processes_drained: processes.every(({ parsed }) => parsed.drained),
    client_runtime: {
      cpu_core_equivalents_sum: round(
        processes.reduce(
          (total, { parsed }) => total + parsed.client_runtime.cpu_core_equivalents,
          0
        )
      ),
      event_loop_utilization_average: round(
        processes.reduce(
          (total, { parsed }) => total + parsed.client_runtime.event_loop_utilization,
          0
        ) / processes.length
      ),
      event_loop_utilization_maximum: Math.max(
        ...processes.map(({ parsed }) => parsed.client_runtime.event_loop_utilization)
      )
    },
    process_results: paths.map((resultPath) => path.relative(rootDirectory, resultPath)),
    queries
  };
  await Promise.all([
    writeFile(
      path.join(rootDirectory, "direct-query-aggregate.json"),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    writeFile(path.join(rootDirectory, "direct-query-aggregate.md"), renderMarkdown(summary))
  ]);
  console.log(JSON.stringify(summary, null, 2));
}

function createState(): AggregateState {
  return {
    targetPerSecond: 0,
    achievedPerSecond: 0,
    achievedRedisOpsPerSecond: 0,
    successfulRequests: 0,
    successfulRequestsDuringWindow: 0,
    errors: 0,
    droppedRequests: 0,
    payloadBytesWeighted: 0,
    payloadMiBPerSecond: 0,
    distinctSampleKeys: [],
    latencyHistogram: new Map(),
    redisLatencyHistogram: new Map()
  };
}

function mergeHistogram(target: Map<number, number>, source: SparseHistogram): void {
  for (const [bucket, count] of source) {
    target.set(bucket, (target.get(bucket) ?? 0) + count);
  }
}

function percentile(histogram: Map<number, number>, quantile: number): number {
  const samples = Array.from(histogram.values()).reduce((total, count) => total + count, 0);
  if (samples === 0) return 0;
  const target = Math.ceil(samples * quantile);
  let seen = 0;
  for (const [bucket, count] of Array.from(histogram.entries()).sort(
    ([left], [right]) => left - right
  )) {
    seen += count;
    if (seen >= target) return bucket;
  }
  return 0;
}

async function findFiles(directory: string, filename: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findFiles(entryPath, filename);
      return entry.isFile() && entry.name === filename ? [entryPath] : [];
    })
  );
  return nested.flat();
}

function renderMarkdown(summary: {
  generator_hosts: number;
  generator_processes: number;
  test_time_seconds: number;
  warmup_time_seconds: number;
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  payload_mebibytes_per_second: number;
  dropped_requests: number;
  errors: number;
  all_processes_drained: boolean;
  client_runtime: {
    cpu_core_equivalents_sum: number;
    event_loop_utilization_average: number;
    event_loop_utilization_maximum: number;
  };
  queries: Array<{
    pattern: string;
    target_per_second: number;
    achieved_per_second: number;
    achievement_ratio: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    redis_p50_latency_ms: number;
    redis_p95_latency_ms: number;
    redis_p99_latency_ms: number;
    errors: number;
    dropped_requests: number;
    average_payload_bytes: number;
    payload_mebibytes_per_second: number;
  }>;
}): string {
  const lines = [
    "# Direct Redis RESP Load Result",
    "",
    `Generators: **${format(summary.generator_hosts)} hosts / ${format(summary.generator_processes)} processes**`,
    `Window: **${format(summary.warmup_time_seconds)}s warm-up + ${format(summary.test_time_seconds)}s measured**`,
    `Total: **${format(summary.achieved_per_second)}/sec achieved / ${format(summary.target_per_second)}/sec target**`,
    `Redis commands: **${format(summary.achieved_redis_ops_per_second)}/sec**`,
    `Payload: **${format(summary.payload_mebibytes_per_second)} MiB/sec**`,
    `Drops/errors: **${format(summary.dropped_requests)} / ${format(summary.errors)}**`,
    `All processes drained: **${summary.all_processes_drained ? "yes" : "no"}**`,
    `Client CPU: **${format(summary.client_runtime.cpu_core_equivalents_sum)} cores**; event loop avg/max **${format(summary.client_runtime.event_loop_utilization_average)} / ${format(summary.client_runtime.event_loop_utilization_maximum)}**`,
    "",
    "| Pattern | Target/sec | Achieved/sec | Ratio | p50/p95/p99 ms | Redis p50/p95/p99 ms | Avg payload bytes | Payload MiB/sec | Drops | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.queries.map(
      (query) =>
        `| \`${query.pattern}\` | ${format(query.target_per_second)} | ${format(query.achieved_per_second)} | ${format(query.achievement_ratio)} | ${format(query.p50_latency_ms)} / ${format(query.p95_latency_ms)} / ${format(query.p99_latency_ms)} | ${format(query.redis_p50_latency_ms)} / ${format(query.redis_p95_latency_ms)} / ${format(query.redis_p99_latency_ms)} | ${format(query.average_payload_bytes)} | ${format(query.payload_mebibytes_per_second)} | ${format(query.dropped_requests)} | ${format(query.errors)} |`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
