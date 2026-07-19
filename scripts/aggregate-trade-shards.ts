import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type LatencySummary = {
  p50: number;
  p95: number;
  p99: number;
  p99_9: number;
};

type TradeShardResult = {
  pattern: "tradeWrites";
  target_ops_per_second: number;
  achieved_ops_per_second: number;
  offered_ops_per_second: number;
  test_time_seconds: number;
  wall_time_seconds: number;
  target_operations: number;
  started_operations: number;
  completed_operations: number;
  inserted_operations: number;
  inserted_operations_during_window: number;
  duplicate_operations: number;
  dropped_operations: number;
  errors: number;
  peak_in_flight: number;
  position_sample_pool_size: number;
  global_account_sample_pool_size: number;
  distinct_account_slots: number;
  distinct_position_keys: number;
  random_seed: number;
  generator_shard: { index: number; count: number; host?: string };
  latency_ms: LatencySummary;
  latency_histogram_ms?: Array<[number, number]>;
};

async function main() {
  const rootDirectory = process.argv[2];
  if (!rootDirectory) throw new Error("Usage: aggregate-trade-shards.ts <distributed-output-directory>");

  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const hostDirectories = entries
    .filter((entry) => entry.isDirectory() && /^host-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const tradeDirectories: string[] = [];
  for (const directory of hostDirectories) {
    const file = path.join(rootDirectory, directory, "trade-writes.json");
    try {
      await access(file);
      tradeDirectories.push(directory);
    } catch {
      // Query-only generator host.
    }
  }
  if (tradeDirectories.length < 2) {
    throw new Error(`Expected at least two trade-writer result directories in ${rootDirectory}.`);
  }

  const shards = await Promise.all(
    tradeDirectories.map(async (directory) => ({
      directory,
      result: JSON.parse(
        await readFile(path.join(rootDirectory, directory, "trade-writes.json"), "utf8")
      ) as TradeShardResult
    }))
  );
  const expectedShardCount = shards.length;
  const shardIndexes = new Set<number>();
  for (const { directory, result } of shards) {
    if (result.pattern !== "tradeWrites") throw new Error(`${directory} is not a trade-write result.`);
    if (result.generator_shard?.count !== expectedShardCount) {
      throw new Error(`${directory} has an inconsistent trade shard count.`);
    }
    if (!result.latency_histogram_ms) {
      throw new Error(`${directory} is missing latency_histogram_ms.`);
    }
    if (shardIndexes.has(result.generator_shard.index)) {
      throw new Error(`${directory} duplicates trade shard ${result.generator_shard.index}.`);
    }
    shardIndexes.add(result.generator_shard.index);
  }

  const latencyHistogram = new Map<number, number>();
  for (const { result } of shards) {
    for (const [latencyMs, count] of result.latency_histogram_ms ?? []) {
      latencyHistogram.set(latencyMs, (latencyHistogram.get(latencyMs) ?? 0) + count);
    }
  }

  const completedOperations = sum(shards, "completed_operations");
  const aggregate = {
    experiment: "distributed-trade-write-load",
    pattern: "tradeWrites",
    generator_processes: expectedShardCount,
    generator_hosts: shards
      .map(({ result }) => result.generator_shard.host)
      .filter((host): host is string => Boolean(host)),
    target_ops_per_second: sum(shards, "target_ops_per_second"),
    achieved_ops_per_second: round(sum(shards, "achieved_ops_per_second")),
    offered_ops_per_second: round(sum(shards, "offered_ops_per_second")),
    test_time_seconds: Math.max(...shards.map(({ result }) => result.test_time_seconds)),
    wall_time_seconds: Math.max(...shards.map(({ result }) => result.wall_time_seconds)),
    target_operations: sum(shards, "target_operations"),
    started_operations: sum(shards, "started_operations"),
    completed_operations: completedOperations,
    inserted_operations: sum(shards, "inserted_operations"),
    inserted_operations_during_window: sum(shards, "inserted_operations_during_window"),
    duplicate_operations: sum(shards, "duplicate_operations"),
    dropped_operations: sum(shards, "dropped_operations"),
    errors: sum(shards, "errors"),
    peak_in_flight_sum: sum(shards, "peak_in_flight"),
    global_account_sample_pool_size: Math.max(
      ...shards.map(({ result }) => result.global_account_sample_pool_size)
    ),
    distinct_account_slots_sum: sum(shards, "distinct_account_slots"),
    distinct_position_keys_sum: sum(shards, "distinct_position_keys"),
    latency_ms: {
      p50: percentile(latencyHistogram, completedOperations, 0.5),
      p95: percentile(latencyHistogram, completedOperations, 0.95),
      p99: percentile(latencyHistogram, completedOperations, 0.99),
      p99_9: percentile(latencyHistogram, completedOperations, 0.999)
    },
    shards: shards
      .sort((left, right) => left.result.generator_shard.index - right.result.generator_shard.index)
      .map(({ directory, result }) => ({
        directory,
        index: result.generator_shard.index,
        host: result.generator_shard.host,
        random_seed: result.random_seed,
        target_ops_per_second: result.target_ops_per_second,
        achieved_ops_per_second: result.achieved_ops_per_second,
        offered_ops_per_second: result.offered_ops_per_second,
        dropped_operations: result.dropped_operations,
        errors: result.errors,
        distinct_account_slots: result.distinct_account_slots,
        peak_in_flight: result.peak_in_flight,
        latency_ms: result.latency_ms
      }))
  };

  const outputPath = path.join(rootDirectory, "trade-writes-aggregate.json");
  await writeFile(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`Wrote ${outputPath}`);
}

function sum<K extends keyof TradeShardResult>(
  shards: Array<{ result: TradeShardResult }>,
  key: K
): number {
  return shards.reduce((total, { result }) => {
    const value = result[key];
    if (typeof value !== "number") throw new Error(`${String(key)} must be numeric.`);
    return total + value;
  }, 0);
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
