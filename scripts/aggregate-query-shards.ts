import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type LatencySummary = {
  p50: number;
  p95: number;
  p99: number;
  p99_9: number;
};

type ShardResult = {
  pattern: string;
  random_seed: number;
  generator_shard?: { index: number; count: number };
  distinct_sample_keys: number;
  target_rps: number;
  achieved_rps: number;
  achieved_redis_ops_per_second: number;
  estimated_target_redis_ops_per_second: number;
  offered_rps: number;
  test_time_seconds: number;
  wall_time_seconds: number;
  target_requests: number;
  started_requests: number;
  completed_requests: number;
  successful_requests: number;
  successful_requests_during_window: number;
  dropped_requests: number;
  http_errors: number;
  request_errors: number;
  http_status_counts: Record<string, number>;
  request_error_counts: Record<string, number>;
  response_bytes: number;
  redis_commands: number;
  response_megabytes_per_second: number;
  peak_in_flight: number;
  latency_ms: LatencySummary;
  latency_histogram_ms?: Array<[number, number]>;
  base_url: string;
};

async function main() {
  const rootDirectory = process.argv[2];
  if (!rootDirectory) throw new Error("Usage: aggregate-query-shards.ts <sharded-output-directory>");

  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const shardDirectories = entries
    .filter((entry) => entry.isDirectory() && /^shard-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (shardDirectories.length < 2) {
    throw new Error(`Expected at least two shard directories in ${rootDirectory}.`);
  }

  const shards = await Promise.all(
    shardDirectories.map(async (directory) => {
      const file = path.join(rootDirectory, directory, "query-account-by-id.json");
      return {
        directory,
        result: JSON.parse(await readFile(file, "utf8")) as ShardResult
      };
    })
  );
  const first = shards[0].result;
  for (const { directory, result } of shards) {
    if (result.pattern !== first.pattern || result.base_url !== first.base_url) {
      throw new Error(`${directory} does not match the other shard query or target.`);
    }
    if (!result.latency_histogram_ms) {
      throw new Error(`${directory} is missing latency_histogram_ms.`);
    }
    if (result.generator_shard?.count !== shards.length) {
      throw new Error(`${directory} has an inconsistent generator shard count.`);
    }
  }

  const latencyHistogram = new Map<number, number>();
  for (const { result } of shards) {
    for (const [latencyMs, count] of result.latency_histogram_ms ?? []) {
      latencyHistogram.set(latencyMs, (latencyHistogram.get(latencyMs) ?? 0) + count);
    }
  }

  const completedRequests = sum(shards, "completed_requests");
  const successfulRequests = sum(shards, "successful_requests");
  const redisCommands = sum(shards, "redis_commands");
  const httpErrors = sum(shards, "http_errors");
  const requestErrors = sum(shards, "request_errors");
  const aggregate = {
    experiment: "sharded-query-load",
    pattern: first.pattern,
    generator_processes: shards.length,
    target_rps: sum(shards, "target_rps"),
    achieved_rps: round(sum(shards, "achieved_rps")),
    achieved_redis_ops_per_second: round(sum(shards, "achieved_redis_ops_per_second")),
    estimated_target_redis_ops_per_second: round(
      sum(shards, "estimated_target_redis_ops_per_second")
    ),
    offered_rps: round(sum(shards, "offered_rps")),
    test_time_seconds: Math.max(...shards.map(({ result }) => result.test_time_seconds)),
    wall_time_seconds: Math.max(...shards.map(({ result }) => result.wall_time_seconds)),
    target_requests: sum(shards, "target_requests"),
    started_requests: sum(shards, "started_requests"),
    completed_requests: completedRequests,
    successful_requests: successfulRequests,
    successful_requests_during_window: sum(shards, "successful_requests_during_window"),
    dropped_requests: sum(shards, "dropped_requests"),
    http_errors: httpErrors,
    request_errors: requestErrors,
    http_status_counts: mergeCounts(shards.map(({ result }) => result.http_status_counts)),
    request_error_counts: mergeCounts(shards.map(({ result }) => result.request_error_counts)),
    error_rate:
      completedRequests === 0 ? 0 : roundTo((httpErrors + requestErrors) / completedRequests, 6),
    response_bytes: sum(shards, "response_bytes"),
    redis_commands: redisCommands,
    redis_commands_per_successful_request:
      successfulRequests === 0 ? 0 : round(redisCommands / successfulRequests),
    response_megabytes_per_second: round(sum(shards, "response_megabytes_per_second")),
    peak_in_flight_sum: sum(shards, "peak_in_flight"),
    distinct_sample_keys_sum: sum(shards, "distinct_sample_keys"),
    latency_ms: {
      p50: percentile(latencyHistogram, completedRequests, 0.5),
      p95: percentile(latencyHistogram, completedRequests, 0.95),
      p99: percentile(latencyHistogram, completedRequests, 0.99),
      p99_9: percentile(latencyHistogram, completedRequests, 0.999)
    },
    base_url: first.base_url,
    shards: shards.map(({ directory, result }) => ({
      directory,
      index: result.generator_shard?.index,
      random_seed: result.random_seed,
      target_rps: result.target_rps,
      achieved_rps: result.achieved_rps,
      dropped_requests: result.dropped_requests,
      http_errors: result.http_errors,
      request_errors: result.request_errors,
      peak_in_flight: result.peak_in_flight,
      latency_ms: result.latency_ms
    }))
  };

  const outputPath = path.join(rootDirectory, "query-account-by-id-aggregate.json");
  await writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`Wrote ${outputPath}`);
}

function sum<K extends keyof ShardResult>(
  shards: Array<{ result: ShardResult }>,
  key: K
): number {
  return shards.reduce((total, { result }) => {
    const value = result[key];
    if (typeof value !== "number") throw new Error(`${String(key)} must be numeric.`);
    return total + value;
  }, 0);
}

function mergeCounts(counts: Array<Record<string, number>>): Record<string, number> {
  const merged = new Map<string, number>();
  for (const entries of counts) {
    for (const [name, count] of Object.entries(entries)) {
      merged.set(name, (merged.get(name) ?? 0) + count);
    }
  }
  return Object.fromEntries([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function percentile(histogram: Map<number, number>, total: number, quantile: number): number {
  if (total === 0) return 0;
  const target = Math.ceil(total * quantile);
  let seen = 0;
  for (const [latencyMs, count] of [...histogram.entries()].sort(([left], [right]) => left - right)) {
    seen += count;
    if (seen >= target) return latencyMs;
  }
  return 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
