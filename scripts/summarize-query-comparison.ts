import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { QUERY_COMPARISON_PAIRS } from "../src/lib/benchmark-samples";

type Latency = {
  p50: number;
  p95: number;
  p99: number;
};

type QueryResult = {
  pattern: string;
  target_rps: number;
  achieved_rps: number;
  dropped_requests: number;
  http_errors: number;
  request_errors: number;
  latency_ms: Latency;
  queue_latency_ms?: Latency;
  redis_latency_ms?: Latency;
  average_api_payload_bytes?: number;
};

const SLUGS = {
  securityByNo: "security-by-no",
  securityByNoDirect: "security-by-no-direct",
  transactionsBySecurity: "transactions-by-security",
  transactionsBySecurityMaterialized:
    "transactions-by-security-materialized",
  transactionsByAccountSecurity: "transactions-by-account-security",
  transactionsByAccountSecurityMaterialized:
    "transactions-by-account-security-materialized"
} as const;

async function main(): Promise<void> {
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error(
      "Usage: summarize-query-comparison.ts <comparison-output-directory>"
    );
  }

  const comparisons = await Promise.all(
    Object.entries(QUERY_COMPARISON_PAIRS).map(
      async ([baselinePattern, optimizedPattern]) => {
        const baseline = await readResult(outputDirectory, baselinePattern);
        const optimized = await readResult(outputDirectory, optimizedPattern);
        return {
          baseline_pattern: baselinePattern,
          optimized_pattern: optimizedPattern,
          target_rps_each: baseline.target_rps,
          baseline: selectedMetrics(baseline),
          optimized: selectedMetrics(optimized),
          optimized_change_percent: {
            achieved_rps: percentChange(
              baseline.achieved_rps,
              optimized.achieved_rps
            ),
            http_p95_ms: percentChange(
              baseline.latency_ms.p95,
              optimized.latency_ms.p95
            ),
            queue_p95_ms: percentChange(
              baseline.queue_latency_ms?.p95 ?? 0,
              optimized.queue_latency_ms?.p95 ?? 0
            ),
            redis_p95_ms: percentChange(
              baseline.redis_latency_ms?.p95 ?? 0,
              optimized.redis_latency_ms?.p95 ?? 0
            )
          }
        };
      }
    )
  );

  const summary = {
    experiment: "baseline-vs-materialized-query-comparison",
    generated_at: new Date().toISOString(),
    note:
      "Both members of each pair ran concurrently against the same Redis database and used the same deterministic sample sequence.",
    comparisons
  };
  const jsonPath = path.join(
    outputDirectory,
    "query-comparison-summary.json"
  );
  const markdownPath = path.join(
    outputDirectory,
    "query-comparison-summary.md"
  );
  const markdown = renderMarkdown(summary);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, markdown)
  ]);
  process.stdout.write(markdown);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

async function readResult(
  outputDirectory: string,
  pattern: string
): Promise<QueryResult> {
  const slug = SLUGS[pattern as keyof typeof SLUGS];
  if (!slug) throw new Error(`No result slug configured for ${pattern}`);
  return JSON.parse(
    await readFile(path.join(outputDirectory, `query-${slug}.json`), "utf8")
  ) as QueryResult;
}

function selectedMetrics(result: QueryResult) {
  return {
    achieved_rps: result.achieved_rps,
    http_latency_ms: result.latency_ms,
    queue_latency_ms: result.queue_latency_ms ?? zeroLatency(),
    redis_latency_ms: result.redis_latency_ms ?? zeroLatency(),
    dropped_requests: result.dropped_requests,
    http_errors: result.http_errors,
    request_errors: result.request_errors,
    average_api_payload_bytes: result.average_api_payload_bytes ?? 0
  };
}

function zeroLatency(): Latency {
  return { p50: 0, p95: 0, p99: 0 };
}

function percentChange(baseline: number, optimized: number): number | null {
  if (!Number.isFinite(baseline) || baseline === 0) return null;
  return round(((optimized - baseline) / baseline) * 100);
}

function renderMarkdown(summary: {
  comparisons: Array<{
    baseline_pattern: string;
    optimized_pattern: string;
    baseline: ReturnType<typeof selectedMetrics>;
    optimized: ReturnType<typeof selectedMetrics>;
    optimized_change_percent: {
      achieved_rps: number | null;
      http_p95_ms: number | null;
      queue_p95_ms: number | null;
      redis_p95_ms: number | null;
    };
  }>;
}): string {
  const lines = [
    "# Baseline vs Materialized Query Comparison",
    "",
    "Both query families ran concurrently with paired deterministic samples. Negative latency change is an improvement.",
    "",
    "| Baseline | Materialized/direct variant | Achieved/sec baseline → variant | HTTP p95 ms baseline → variant | API queue p95 ms baseline → variant | Redis p95 ms baseline → variant | Variant Redis p95 change | Drops/errors baseline → variant |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...summary.comparisons.map((comparison) => {
      const baselineFailures =
        comparison.baseline.dropped_requests +
        comparison.baseline.http_errors +
        comparison.baseline.request_errors;
      const optimizedFailures =
        comparison.optimized.dropped_requests +
        comparison.optimized.http_errors +
        comparison.optimized.request_errors;
      return `| \`${comparison.baseline_pattern}\` | \`${comparison.optimized_pattern}\` | ${format(comparison.baseline.achieved_rps)} → ${format(comparison.optimized.achieved_rps)} | ${format(comparison.baseline.http_latency_ms.p95)} → ${format(comparison.optimized.http_latency_ms.p95)} | ${format(comparison.baseline.queue_latency_ms.p95)} → ${format(comparison.optimized.queue_latency_ms.p95)} | ${format(comparison.baseline.redis_latency_ms.p95)} → ${format(comparison.optimized.redis_latency_ms.p95)} | ${formatPercent(comparison.optimized_change_percent.redis_p95_ms)} | ${format(baselineFailures)} → ${format(optimizedFailures)} |`;
    }),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${format(value)}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
