import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Aggregate = {
  generated_at: string;
  generator_processes: number;
  generator_hosts: number;
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  payload_mebibytes_per_second: number;
  dropped_requests: number;
  errors: number;
  all_processes_drained: boolean;
  queries: Array<{
    pattern: string;
    target_per_second: number;
    achieved_per_second: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    average_payload_bytes: number;
    dropped_requests: number;
    errors: number;
  }>;
};

type Step = Aggregate & {
  desired_target_per_second: number;
  source: string;
};

async function main() {
  const [outputDirectory, ...roots] = process.argv.slice(2);
  if (!outputDirectory || roots.length === 0) {
    throw new Error(
      "Usage: summarize-direct-redis-staircase.ts <output-directory> <staircase-root> [staircase-root ...]"
    );
  }

  const selected = new Map<number, Step>();
  for (const root of roots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const match = entry.isDirectory() && entry.name.match(/^step-(\d+)-rps$/);
      if (!match) continue;
      const source = path.join(root, entry.name, "direct-query-aggregate.json");
      const aggregate = JSON.parse(await readFile(source, "utf8")) as Aggregate;
      const desiredTarget = Number(match[1]);
      const candidate = {
        ...aggregate,
        desired_target_per_second: desiredTarget,
        source
      };
      const current = selected.get(desiredTarget);
      if (
        !current ||
        candidate.generator_processes > current.generator_processes ||
        (candidate.generator_processes === current.generator_processes &&
          candidate.generated_at > current.generated_at)
      ) {
        selected.set(desiredTarget, candidate);
      }
    }
  }

  const steps = [...selected.values()].sort(
    (left, right) =>
      left.desired_target_per_second - right.desired_target_per_second
  );
  const summary = {
    experiment: "direct-redis-architecture-staircase",
    architecture: "AWS load generators -> Redis Cloud OSS Cluster API",
    generated_at: new Date().toISOString(),
    steps
  };
  const markdown = renderMarkdown(steps);
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "direct-redis-staircase-summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    writeFile(
      path.join(outputDirectory, "direct-redis-staircase-summary.md"),
      markdown
    )
  ]);
  process.stdout.write(markdown);
}

function renderMarkdown(steps: Step[]) {
  const lines = [
    "# Direct Redis Architecture Staircase",
    "",
    "Path: **AWS load generators -> Redis Cloud OSS Cluster API**. No HTTP, ALB, or API tier is present.",
    "",
    "| Desired target/sec | Measured target/sec | Achieved/sec | Achievement | Redis reads/sec | Payload MiB/sec | Drops | Errors | Drained | Processes |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|",
    ...steps.map(
      (step) =>
        `| ${format(step.desired_target_per_second)} | ${format(step.target_per_second)} | ${format(step.achieved_per_second)} | ${formatPercent(step.achieved_per_second / step.desired_target_per_second)} | ${format(step.achieved_redis_ops_per_second)} | ${format(step.payload_mebibytes_per_second)} | ${format(step.dropped_requests)} | ${format(step.errors)} | ${step.all_processes_drained ? "yes" : "no"} | ${step.generator_processes} |`
    ),
    "",
    "## Complete 180K per-pattern result",
    ""
  ];
  const finalStep = steps.find(
    (step) => step.desired_target_per_second === 180_000
  );
  if (finalStep) {
    lines.push(
      "| Pattern | Target/sec | Achieved/sec | p50 ms | p95 ms | p99 ms | Avg payload bytes | Drops | Errors |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...finalStep.queries.map(
        (query) =>
          `| \`${query.pattern}\` | ${format(query.target_per_second)} | ${format(query.achieved_per_second)} | ${format(query.p50_latency_ms)} | ${format(query.p95_latency_ms)} | ${format(query.p99_latency_ms)} | ${format(query.average_payload_bytes)} | ${format(query.dropped_requests)} | ${format(query.errors)} |`
      ),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function format(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value
  );
}

function formatPercent(value: number) {
  return `${format(value * 100)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
