import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type ReadQuery = {
  pattern: string;
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
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
};

type ReadSummary = {
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  payload_mebibytes_per_second: number;
  dropped_requests: number;
  errors: number;
  generator_hosts: number;
  generator_processes: number;
  client_runtime: {
    cpu_core_equivalents_sum: number;
    event_loop_utilization_average: number;
    event_loop_utilization_maximum: number;
  };
  queries: ReadQuery[];
};

type WriteSummary = {
  target_ops_per_second: number;
  offered_ops_per_second: number;
  achieved_ops_per_second: number;
  dropped_operations: number;
  duplicate_operations: number;
  errors: number;
  generator_processes: number;
  latency_ms: { p50: number; p95: number; p99: number; p99_9: number };
  correctness?: {
    validations_started: number;
    validations_passed: number;
    validations_failed: number;
    validations_in_flight: number;
    errors: Array<{ directory: string; error: string }>;
  };
};

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    throw new Error("Usage: summarize-direct-read-write.ts <result-directory>");
  }
  const absoluteRoot = path.resolve(root);
  const reads = JSON.parse(
    await readFile(path.join(absoluteRoot, "direct-query-aggregate.json"), "utf8")
  ) as ReadSummary;
  const writes = JSON.parse(
    await readFile(path.join(absoluteRoot, "trade-writes-aggregate.json"), "utf8")
  ) as WriteSummary;
  const summary = {
    experiment: "direct-redis-full-read-write-load",
    architecture: "dedicated AWS load generators -> Redis Cloud OSS Cluster API",
    generated_at: new Date().toISOString(),
    reads,
    writes,
    combined: {
      target_logical_operations_per_second:
        reads.target_per_second + writes.target_ops_per_second,
      offered_write_operations_per_second: writes.offered_ops_per_second,
      achieved_logical_operations_per_second:
        reads.achieved_per_second + writes.achieved_ops_per_second,
      achieved_client_commands_per_second:
        reads.achieved_redis_ops_per_second + writes.achieved_ops_per_second,
      dropped_operations: reads.dropped_requests + writes.dropped_operations,
      errors: reads.errors + writes.errors,
      correctness_failures: writes.correctness?.validations_failed ?? 0
    }
  };
  await Promise.all([
    writeFile(
      path.join(absoluteRoot, "direct-read-write-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    writeFile(
      path.join(absoluteRoot, "direct-read-write-summary.md"),
      renderMarkdown(summary)
    )
  ]);
  process.stdout.write(renderMarkdown(summary));
}

function renderMarkdown(summary: {
  reads: ReadSummary;
  writes: WriteSummary;
  combined: {
    target_logical_operations_per_second: number;
    achieved_logical_operations_per_second: number;
    achieved_client_commands_per_second: number;
    dropped_operations: number;
    errors: number;
    correctness_failures: number;
  };
}): string {
  const lines = [
    "# Direct Redis Full Read/Write Result",
    "",
    "Path: **dedicated AWS generators -> Redis Cloud OSS Cluster API**",
    "",
    `Combined target: **${format(summary.combined.target_logical_operations_per_second)}/sec**`,
    `Combined achieved: **${format(summary.combined.achieved_logical_operations_per_second)}/sec**`,
    `Client commands: **${format(summary.combined.achieved_client_commands_per_second)}/sec**`,
    `Drops/errors: **${format(summary.combined.dropped_operations)} / ${format(summary.combined.errors)}**`,
    "",
    "## Reads",
    "",
    "| Pattern | Target/sec | Achieved/sec | p50/p95/p99 ms | Redis p50/p95/p99 ms | Avg payload bytes | Payload MiB/sec | Drops | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.reads.queries.map(
      (query) =>
        `| \`${query.pattern}\` | ${format(query.target_per_second)} | ${format(query.achieved_per_second)} | ${format(query.p50_latency_ms)} / ${format(query.p95_latency_ms)} / ${format(query.p99_latency_ms)} | ${format(query.redis_p50_latency_ms)} / ${format(query.redis_p95_latency_ms)} / ${format(query.redis_p99_latency_ms)} | ${format(query.average_payload_bytes)} | ${format(query.payload_mebibytes_per_second)} | ${format(query.dropped_requests)} | ${format(query.errors)} |`
    ),
    "",
    "## Writes",
    "",
    `Target/Offered/Achieved: **${format(summary.writes.target_ops_per_second)} / ${format(summary.writes.offered_ops_per_second)} / ${format(summary.writes.achieved_ops_per_second)} per second**`,
    `Latency p50/p95/p99/p99.9: **${format(summary.writes.latency_ms.p50)} / ${format(summary.writes.latency_ms.p95)} / ${format(summary.writes.latency_ms.p99)} / ${format(summary.writes.latency_ms.p99_9)} ms**`,
    `Drops/duplicates/errors: **${format(summary.writes.dropped_operations)} / ${format(summary.writes.duplicate_operations)} / ${format(summary.writes.errors)}**`,
    `Correctness passed/failed/in-flight: **${format(summary.writes.correctness?.validations_passed ?? 0)} / ${format(summary.writes.correctness?.validations_failed ?? 0)} / ${format(summary.writes.correctness?.validations_in_flight ?? 0)}**`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
