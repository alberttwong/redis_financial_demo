import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type MetricDefinition = {
  key: string;
  metricName: string;
  statistic: string;
  aggregation: "sum" | "average" | "minimum" | "maximum";
  scale?: number;
};

type CloudWatchResult = {
  Id: string;
  Label?: string;
  Timestamps?: string[];
  Values?: number[];
  StatusCode?: string;
  Messages?: Array<{ Code?: string; Value?: string }>;
};

const execFileAsync = promisify(execFile);
const METRICS: MetricDefinition[] = [
  {
    key: "request_count_per_target",
    metricName: "RequestCountPerTarget",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "target_response_time_average_ms",
    metricName: "TargetResponseTime",
    statistic: "Average",
    aggregation: "average",
    scale: 1_000
  },
  {
    key: "target_response_time_p95_ms",
    metricName: "TargetResponseTime",
    statistic: "p95",
    aggregation: "maximum",
    scale: 1_000
  },
  {
    key: "target_response_time_p99_ms",
    metricName: "TargetResponseTime",
    statistic: "p99",
    aggregation: "maximum",
    scale: 1_000
  },
  {
    key: "target_2xx_count",
    metricName: "HTTPCode_Target_2XX_Count",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "target_3xx_count",
    metricName: "HTTPCode_Target_3XX_Count",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "target_4xx_count",
    metricName: "HTTPCode_Target_4XX_Count",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "target_5xx_count",
    metricName: "HTTPCode_Target_5XX_Count",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "target_connection_error_count",
    metricName: "TargetConnectionErrorCount",
    statistic: "Sum",
    aggregation: "sum"
  },
  {
    key: "healthy_host_count_min",
    metricName: "HealthyHostCount",
    statistic: "Minimum",
    aggregation: "minimum"
  },
  {
    key: "unhealthy_host_count_max",
    metricName: "UnHealthyHostCount",
    statistic: "Maximum",
    aggregation: "maximum"
  }
];

async function main() {
  const [startedAt, endedAt, loadBalancerSuffix, targetGroupJson, outputDirectory] =
    process.argv.slice(2);
  if (
    !startedAt ||
    !endedAt ||
    !loadBalancerSuffix ||
    !targetGroupJson ||
    !outputDirectory
  ) {
    throw new Error(
      "Usage: capture-alb-target-metrics.ts <start-iso> <end-iso> <load-balancer-arn-suffix> <target-group-arns-json> <output-directory>"
    );
  }
  const targetGroups = JSON.parse(targetGroupJson) as Record<string, string>;
  const queries = Object.entries(targetGroups).flatMap(([pool, targetGroupArn]) =>
    METRICS.map((metric) => ({
      Id: metricId(pool, metric.key),
      Label: `${pool}:${metric.key}`,
      MetricStat: {
        Metric: {
          Namespace: "AWS/ApplicationELB",
          MetricName: metric.metricName,
          Dimensions: [
            { Name: "LoadBalancer", Value: loadBalancerSuffix },
            { Name: "TargetGroup", Value: targetGroupSuffix(targetGroupArn) }
          ]
        },
        Period: 60,
        Stat: metric.statistic
      },
      ReturnData: true
    }))
  );

  await mkdir(outputDirectory, { recursive: true });
  const queryPath = path.join(outputDirectory, "alb-target-metric-queries.json");
  await writeFile(queryPath, `${JSON.stringify(queries, null, 2)}\n`);
  const { stdout } = await execFileAsync(
    "aws",
    [
      "cloudwatch",
      "get-metric-data",
      "--region",
      process.env.AWS_REGION ?? "us-west-2",
      "--start-time",
      startedAt,
      "--end-time",
      endedAt,
      "--scan-by",
      "TimestampAscending",
      "--metric-data-queries",
      `file://${queryPath}`,
      "--output",
      "json"
    ],
    { maxBuffer: 20 * 1024 * 1024 }
  );
  const raw = JSON.parse(stdout) as { MetricDataResults?: CloudWatchResult[] };
  const resultsById = new Map(
    (raw.MetricDataResults ?? []).map((result) => [result.Id, result])
  );
  const pools = Object.keys(targetGroups)
    .sort()
    .map((pool) => ({
      pool,
      target_group_arn: targetGroups[pool],
      metrics: Object.fromEntries(
        METRICS.map((metric) => {
          const result = resultsById.get(metricId(pool, metric.key));
          const values = (result?.Values ?? []).map(
            (value) => value * (metric.scale ?? 1)
          );
          return [
            metric.key,
            {
              value: values.length === 0 ? null : aggregate(values, metric.aggregation),
              datapoint_count: values.length,
              status: result?.StatusCode ?? "Missing",
              datapoints: (result?.Timestamps ?? []).map((timestamp, index) => ({
                timestamp,
                value: round(values[index] ?? 0)
              })),
              messages: result?.Messages ?? []
            }
          ];
        })
      )
    }));
  const output = {
    experiment: "alb-target-metrics",
    captured_at: new Date().toISOString(),
    metric_window: {
      started_at: startedAt,
      ended_at: endedAt,
      period_seconds: 60
    },
    load_balancer_arn_suffix: loadBalancerSuffix,
    pools
  };
  const jsonPath = path.join(outputDirectory, "alb-target-metrics.json");
  const markdownPath = path.join(outputDirectory, "alb-target-metrics.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(output))
  ]);
  process.stdout.write(renderMarkdown(output));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

function targetGroupSuffix(arn: string): string {
  const marker = ":targetgroup/";
  const index = arn.indexOf(marker);
  if (index < 0) throw new Error(`Invalid ALB target-group ARN: ${arn}`);
  return `targetgroup/${arn.slice(index + marker.length)}`;
}

function metricId(pool: string, metric: string): string {
  return `${pool}_${metric}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function aggregate(
  values: number[],
  operation: MetricDefinition["aggregation"]
): number {
  if (values.length === 0) return 0;
  if (operation === "sum") {
    return round(values.reduce((total, value) => total + value, 0));
  }
  if (operation === "average") {
    return round(values.reduce((total, value) => total + value, 0) / values.length);
  }
  return round(
    operation === "minimum" ? Math.min(...values) : Math.max(...values)
  );
}

function renderMarkdown(output: {
  pools: Array<{
    pool: string;
    metrics: Record<string, { value: number | null; datapoint_count: number }>;
  }>;
}): string {
  const lines = [
    "# ALB Target Metrics",
    "",
    "Latency p95 and p99 are the worst one-minute CloudWatch percentile observed during the load window.",
    "",
    "| API pool | Target responses | Requests/target | Target response avg ms | Target response p95/p99 ms | 2xx | 3xx | 4xx | 5xx | Target connection errors | Healthy min | Unhealthy max |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...output.pools.map((entry) => {
      const metric = (name: string) => entry.metrics[name]?.value ?? null;
      const targetResponses = sumOptional([
        metric("target_2xx_count"),
        metric("target_3xx_count"),
        metric("target_4xx_count"),
        metric("target_5xx_count")
      ]);
      return `| \`${entry.pool}\` | ${formatOptional(targetResponses)} | ${formatOptional(metric("request_count_per_target"))} | ${formatOptional(metric("target_response_time_average_ms"))} | ${formatOptional(metric("target_response_time_p95_ms"))} / ${formatOptional(metric("target_response_time_p99_ms"))} | ${formatOptional(metric("target_2xx_count"))} | ${formatOptional(metric("target_3xx_count"))} | ${formatOptional(metric("target_4xx_count"))} | ${formatOptional(metric("target_5xx_count"))} | ${formatOptional(metric("target_connection_error_count"))} | ${formatOptional(metric("healthy_host_count_min"))} | ${formatOptional(metric("unhealthy_host_count_max"))} |`;
    }),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatOptional(value: number | null): string {
  return value === null ? "n/a" : format(value);
}

function sumOptional(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length === 0
    ? null
    : available.reduce((total, value) => total + value, 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
