import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  directQueryWeight,
  parseDirectQueryPatterns,
  type DirectQueryPattern
} from "../src/lib/direct-query-benchmark";

type DiagnosticConfig = {
  query_patterns: string;
  thresholds: {
    p95_slo_ms: number;
    min_achievement_ratio: number;
    max_error_rate: number;
    require_zero_drops: boolean;
    require_drained: boolean;
  };
};

type QueryResult = {
  pattern: DirectQueryPattern;
  target_per_second: number;
  achieved_per_second: number;
  achieved_redis_ops_per_second: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  redis_p50_latency_ms: number;
  redis_p95_latency_ms: number;
  redis_p99_latency_ms: number;
  average_payload_bytes: number;
  payload_mebibytes_per_second: number;
  distinct_sample_keys_min: number;
  distinct_sample_keys_max: number;
  dropped_requests: number;
  errors: number;
};

type Aggregate = {
  generator_hosts: number;
  generator_processes: number;
  test_time_seconds: number;
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
  queries: QueryResult[];
};

type DiagnosticStep = {
  target_per_second: number;
  achieved_per_second: number;
  achievement_ratio: number;
  achieved_redis_ops_per_second: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  redis_p50_latency_ms: number;
  redis_p95_latency_ms: number;
  redis_p99_latency_ms: number;
  average_payload_bytes: number;
  payload_mebibytes_per_second: number;
  distinct_sample_keys_min: number;
  distinct_sample_keys_max: number;
  dropped_requests: number;
  errors: number;
  all_processes_drained: boolean;
  client_cpu_cores: number;
  event_loop_utilization_average: number;
  event_loop_utilization_maximum: number;
  passed: boolean;
  failure_reasons: string[];
  source: string;
};

async function main() {
  const [outputDirectoryValue, ...staircaseRoots] = process.argv.slice(2);
  if (!outputDirectoryValue || staircaseRoots.length === 0) {
    throw new Error(
      "Usage: summarize-direct-redis-pattern-diagnostic.ts <output-directory> <staircase-root> [staircase-root ...]"
    );
  }

  const outputDirectory = path.resolve(outputDirectoryValue);
  const headroomFactor = readPositiveNumber("DIRECT_QUERY_HEADROOM_FACTOR", 1.3);
  if (headroomFactor < 1) {
    throw new Error("DIRECT_QUERY_HEADROOM_FACTOR must be at least one.");
  }

  const patterns = await Promise.all(
    staircaseRoots.map((root) => summarizePattern(path.resolve(root), headroomFactor))
  );
  patterns.sort(
    (left, right) =>
      DIRECT_PATTERN_ORDER.indexOf(left.pattern) -
      DIRECT_PATTERN_ORDER.indexOf(right.pattern)
  );

  const totalWeight = patterns.reduce((total, pattern) => total + pattern.query_weight, 0);
  const ratioLimitedTotals = patterns
    .filter((pattern) => pattern.safe_per_second > 0)
    .map(
      (pattern) =>
        (pattern.safe_per_second * totalWeight) / pattern.query_weight
    );
  const allPatternsValidated =
    patterns.length === DIRECT_PATTERN_ORDER.length &&
    patterns.every((pattern) => pattern.safe_per_second > 0);
  const recommendedMixedTarget = allPatternsValidated
    ? Math.floor(Math.min(...ratioLimitedTotals))
    : 0;
  const summary = {
    experiment: "isolated-direct-redis-pattern-diagnostic",
    architecture: "AWS load generators -> Redis Cloud OSS Cluster API",
    generated_at: new Date().toISOString(),
    headroom_factor: headroomFactor,
    query_weight_total: totalWeight,
    all_patterns_validated: allPatternsValidated,
    recommended_mixed_validation_target_per_second: recommendedMixedTarget,
    patterns
  };

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "direct-redis-pattern-diagnostic.json"),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    writeFile(
      path.join(outputDirectory, "direct-redis-pattern-diagnostic.md"),
      renderMarkdown(summary)
    )
  ]);
  process.stdout.write(renderMarkdown(summary));
}

async function summarizePattern(root: string, headroomFactor: number) {
  const config = JSON.parse(
    await readFile(path.join(root, "diagnostic-config.json"), "utf8")
  ) as DiagnosticConfig;
  const selectedPatterns = parseDirectQueryPatterns(config.query_patterns);
  if (selectedPatterns.length !== 1) {
    throw new Error(`${root} must contain exactly one isolated query pattern.`);
  }
  const pattern = selectedPatterns[0];
  const entries = await readdir(root, { withFileTypes: true });
  const steps: DiagnosticStep[] = [];
  for (const entry of entries) {
    const match = entry.isDirectory() && entry.name.match(/^step-(\d+)-rps$/);
    if (!match) continue;
    const source = path.join(root, entry.name, "direct-query-aggregate.json");
    const aggregate = JSON.parse(await readFile(source, "utf8")) as Aggregate;
    const query = aggregate.queries.find((candidate) => candidate.pattern === pattern);
    if (!query) {
      throw new Error(`${source} does not contain ${pattern}.`);
    }
    const achievementRatio =
      aggregate.target_per_second === 0
        ? 0
        : aggregate.achieved_per_second / aggregate.target_per_second;
    const errorRate =
      aggregate.target_per_second === 0 || aggregate.test_time_seconds === 0
        ? 0
        : aggregate.errors /
          (aggregate.target_per_second * aggregate.test_time_seconds);
    const failureReasons = [
      ...(config.thresholds.require_zero_drops && aggregate.dropped_requests > 0
        ? [`${aggregate.dropped_requests} scheduler drops`]
        : []),
      ...(errorRate > config.thresholds.max_error_rate
        ? [
            `error rate ${format(errorRate)} exceeds ${format(config.thresholds.max_error_rate)}`
          ]
        : []),
      ...(achievementRatio < config.thresholds.min_achievement_ratio
        ? [
            `achievement ratio ${format(achievementRatio)} is below ${format(config.thresholds.min_achievement_ratio)}`
          ]
        : []),
      ...(query.p95_latency_ms > config.thresholds.p95_slo_ms
        ? [
            `p95 ${format(query.p95_latency_ms)}ms exceeds ${format(config.thresholds.p95_slo_ms)}ms`
          ]
        : []),
      ...(config.thresholds.require_drained && !aggregate.all_processes_drained
        ? ["one or more processes did not drain"]
        : [])
    ];
    steps.push({
      target_per_second: aggregate.target_per_second,
      achieved_per_second: aggregate.achieved_per_second,
      achievement_ratio: round(achievementRatio),
      achieved_redis_ops_per_second: aggregate.achieved_redis_ops_per_second,
      p50_latency_ms: query.p50_latency_ms,
      p95_latency_ms: query.p95_latency_ms,
      p99_latency_ms: query.p99_latency_ms,
      redis_p50_latency_ms: query.redis_p50_latency_ms,
      redis_p95_latency_ms: query.redis_p95_latency_ms,
      redis_p99_latency_ms: query.redis_p99_latency_ms,
      average_payload_bytes: query.average_payload_bytes,
      payload_mebibytes_per_second: aggregate.payload_mebibytes_per_second,
      distinct_sample_keys_min: query.distinct_sample_keys_min,
      distinct_sample_keys_max: query.distinct_sample_keys_max,
      dropped_requests: aggregate.dropped_requests,
      errors: aggregate.errors,
      all_processes_drained: aggregate.all_processes_drained,
      client_cpu_cores: aggregate.client_runtime.cpu_core_equivalents_sum,
      event_loop_utilization_average:
        aggregate.client_runtime.event_loop_utilization_average,
      event_loop_utilization_maximum:
        aggregate.client_runtime.event_loop_utilization_maximum,
      passed: failureReasons.length === 0,
      failure_reasons: failureReasons,
      source: path.relative(process.cwd(), source)
    });
  }
  steps.sort((left, right) => left.target_per_second - right.target_per_second);
  if (steps.length === 0) {
    throw new Error(`${root} does not contain any completed staircase steps.`);
  }
  const validatedStep = steps.filter((step) => step.passed).at(-1) ?? null;
  const firstFailedStep = steps.find((step) => !step.passed) ?? null;
  const validatedPerSecond = validatedStep?.achieved_per_second ?? 0;
  return {
    pattern,
    query_weight: directQueryWeight(pattern),
    thresholds: config.thresholds,
    validated_per_second: validatedPerSecond,
    safe_per_second: round(validatedPerSecond / headroomFactor),
    first_limit_target_per_second: firstFailedStep?.target_per_second ?? null,
    limiting_reasons: firstFailedStep?.failure_reasons ?? [],
    steps,
    staircase_root: path.relative(process.cwd(), root)
  };
}

function renderMarkdown(summary: {
  headroom_factor: number;
  all_patterns_validated: boolean;
  recommended_mixed_validation_target_per_second: number;
  patterns: Array<Awaited<ReturnType<typeof summarizePattern>>>;
}) {
  const lines = [
    "# Direct Redis Per-Pattern Diagnostic",
    "",
    "Path: **AWS load generators -> Redis Cloud OSS Cluster API**. No ALB or API tier is present.",
    "",
    `Capacity headroom factor: **${format(summary.headroom_factor)}x**.`,
    `Recommended ratio-preserving mixed validation target: **${format(summary.recommended_mixed_validation_target_per_second)}/sec**.`,
    "",
    "| Pattern | Weight | Validated/sec | Safe/sec | First limit target/sec | Validated p95 ms | Avg payload bytes | Limiting reason |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
    ...summary.patterns.map((pattern) => {
      const validatedStep = pattern.steps.filter((step) => step.passed).at(-1);
      return `| \`${pattern.pattern}\` | ${format(pattern.query_weight)} | ${format(pattern.validated_per_second)} | ${format(pattern.safe_per_second)} | ${pattern.first_limit_target_per_second === null ? "not reached" : format(pattern.first_limit_target_per_second)} | ${validatedStep ? format(validatedStep.p95_latency_ms) : "n/a"} | ${validatedStep ? format(validatedStep.average_payload_bytes) : "n/a"} | ${pattern.limiting_reasons.join("; ") || "not reached"} |`;
    }),
    "",
    "## Staircase steps",
    ""
  ];
  for (const pattern of summary.patterns) {
    lines.push(
      `### ${pattern.pattern}`,
      "",
      "| Target/sec | Achieved/sec | Redis ops/sec | p50/p95/p99 ms | Payload MiB/sec | Sample keys min-max | Drops | Errors | Result |",
      "|---:|---:|---:|---:|---:|---:|---:|---:|---|",
      ...pattern.steps.map(
        (step) =>
          `| ${format(step.target_per_second)} | ${format(step.achieved_per_second)} | ${format(step.achieved_redis_ops_per_second)} | ${format(step.p50_latency_ms)} / ${format(step.p95_latency_ms)} / ${format(step.p99_latency_ms)} | ${format(step.payload_mebibytes_per_second)} | ${format(step.distinct_sample_keys_min)}-${format(step.distinct_sample_keys_max)} | ${format(step.dropped_requests)} | ${format(step.errors)} | ${step.passed ? "PASS" : `LIMIT: ${step.failure_reasons.join("; ")}`} |`
      ),
      ""
    );
  }
  if (!summary.all_patterns_validated) {
    lines.push(
      "A mixed validation target was not calculated because at least one pattern had no passing step.",
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function readPositiveNumber(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function format(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

const DIRECT_PATTERN_ORDER = [
  "accountById",
  "securityById",
  "securityByNo",
  "positionByComposite",
  "positionsByAccount",
  "transactionById",
  "transactionsByAccount",
  "transactionsBySecurity",
  "transactionsByAccountSecurity",
  "accountPortfolioJoin",
  "accountActivityJoin",
  "accountSnapshot"
] as const satisfies readonly DirectQueryPattern[];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
