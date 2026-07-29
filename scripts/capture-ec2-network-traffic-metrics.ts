import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type MetricResult = {
  Id: string;
  Timestamps?: string[];
  Values?: number[];
  StatusCode?: string;
};

const execFileAsync = promisify(execFile);
const PERIOD_SECONDS = 60;
const METRICS = [
  { name: "NetworkIn", unit: "bytes" },
  { name: "NetworkOut", unit: "bytes" },
  { name: "NetworkPacketsIn", unit: "packets" },
  { name: "NetworkPacketsOut", unit: "packets" }
] as const;
const STATS = ["Sum", "Average", "Minimum", "Maximum"] as const;

async function main(): Promise<void> {
  const [startedAt, endedAt, fleetJson, outputDirectory] = process.argv.slice(2);
  if (!startedAt || !endedAt || !fleetJson || !outputDirectory) {
    throw new Error(
      "Usage: capture-ec2-network-traffic-metrics.ts <start-iso> <end-iso> <fleet-instance-ids-json> <output-directory>"
    );
  }
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
    throw new Error("The metric window must contain valid ISO timestamps with end after start.");
  }
  const fleets = normalizeFleets(JSON.parse(fleetJson) as Record<string, unknown>);
  const instances = Object.entries(fleets).flatMap(([fleet, ids]) =>
    ids.map((instanceId) => ({ fleet, instanceId }))
  );
  if (instances.length === 0) throw new Error("At least one EC2 instance ID is required.");
  await mkdir(outputDirectory, { recursive: true });

  const queryDefinitions = instances.flatMap((instance, instanceIndex) =>
    METRICS.flatMap((metric, metricIndex) =>
      STATS.map((stat, statIndex) => ({
        id: `q${String(instanceIndex * METRICS.length * STATS.length + metricIndex * STATS.length + statIndex + 1).padStart(5, "0")}`,
        ...instance,
        metric: metric.name,
        unit: metric.unit,
        stat,
        query: {
          Id: `q${String(instanceIndex * METRICS.length * STATS.length + metricIndex * STATS.length + statIndex + 1).padStart(5, "0")}`,
          MetricStat: {
            Metric: {
              Namespace: "AWS/EC2",
              MetricName: metric.name,
              Dimensions: [{ Name: "InstanceId", Value: instance.instanceId }]
            },
            Period: PERIOD_SECONDS,
            Stat: stat
          },
          ReturnData: true
        }
      }))
    )
  );
  const responses: MetricResult[] = [];
  for (let offset = 0; offset < queryDefinitions.length; offset += 400) {
    const batch = queryDefinitions.slice(offset, offset + 400);
    const queryPath = path.join(
      outputDirectory,
      `ec2-network-traffic-queries-${String(offset / 400 + 1).padStart(2, "0")}.json`
    );
    await writeFile(queryPath, `${JSON.stringify(batch.map((entry) => entry.query), null, 2)}\n`);
    const response = await awsJson<{ MetricDataResults?: MetricResult[] }>([
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
    ]);
    responses.push(...(response.MetricDataResults ?? []));
  }
  const byId = new Map(responses.map((result) => [result.Id, result]));
  const durationSeconds = (endedMs - startedMs) / 1_000;
  const instanceMetrics = instances.map(({ fleet, instanceId }) => {
    const metrics = Object.fromEntries(
      METRICS.map((metric) => {
        const statValues = Object.fromEntries(
          STATS.map((stat) => {
            const definition = queryDefinitions.find(
              (entry) =>
                entry.instanceId === instanceId &&
                entry.metric === metric.name &&
                entry.stat === stat
            );
            const result = definition ? byId.get(definition.id) : undefined;
            const values = result?.Values ?? [];
            const value =
              stat === "Sum"
                ? values.reduce((total, current) => total + current, 0)
                : stat === "Average"
                  ? values.length === 0
                    ? null
                    : values.reduce((total, current) => total + current, 0) / values.length
                  : stat === "Minimum"
                    ? values.length === 0
                      ? null
                      : Math.min(...values)
                    : values.length === 0
                      ? null
                      : Math.max(...values);
            return [stat.toLowerCase(), value];
          })
        );
        const sum = Number(statValues.sum ?? 0);
        return [
          metric.name,
          {
            unit: metric.unit,
            sum,
            average: statValues.average ?? null,
            minimum: statValues.minimum ?? null,
            maximum: statValues.maximum ?? null,
            average_per_second: sum / durationSeconds,
            average_gib_per_second:
              metric.unit === "bytes" ? sum / durationSeconds / 1024 / 1024 / 1024 : null
          }
        ];
      })
    );
    return { fleet, instance_id: instanceId, metrics };
  });
  const summary = {
    experiment: "ec2-network-traffic-metrics",
    captured_at: new Date().toISOString(),
    metric_window: { started_at: startedAt, ended_at: endedAt, duration_seconds: durationSeconds },
    fleets: Object.keys(fleets).sort().map((fleet) => {
      const fleetInstances = instanceMetrics.filter((instance) => instance.fleet === fleet);
      return {
        fleet,
        instance_count: fleetInstances.length,
        metrics: Object.fromEntries(
          METRICS.map((metric) => {
            const values = fleetInstances.map(
              (instance) =>
                instance.metrics[metric.name] as {
                  sum: number;
                  average_per_second: number;
                  average_gib_per_second: number | null;
                }
            );
            return [
              metric.name,
              {
                unit: metric.unit,
                sum: values.reduce((total, value) => total + value.sum, 0),
                average_per_instance:
                  values.reduce((total, value) => total + value.sum, 0) / values.length,
                minimum_per_instance: Math.min(...values.map((value) => value.sum)),
                maximum_per_instance: Math.max(...values.map((value) => value.sum)),
                aggregate_average_per_second: values.reduce(
                  (total, value) => total + value.average_per_second,
                  0
                ),
                aggregate_average_gib_per_second:
                  metric.unit === "bytes"
                    ? values.reduce(
                        (total, value) => total + (value.average_gib_per_second ?? 0),
                        0
                      )
                    : null
              }
            ];
          })
        ),
        instances: fleetInstances
      };
    })
  };
  const jsonPath = path.join(outputDirectory, "ec2-network-traffic-metrics.json");
  const markdownPath = path.join(outputDirectory, "ec2-network-traffic-metrics.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(summary))
  ]);
  process.stdout.write(renderMarkdown(summary));
}

function normalizeFleets(value: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(value).map(([fleet, ids]) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
        throw new Error(`Fleet ${fleet} must be an array of EC2 instance IDs.`);
      }
      return [fleet, [...new Set(ids as string[])]];
    })
  );
}

async function awsJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("aws", args, {
    maxBuffer: 64 * 1024 * 1024,
    env: process.env
  });
  return JSON.parse(stdout) as T;
}

function renderMarkdown(summary: {
  metric_window: { started_at: string; ended_at: string; duration_seconds: number };
  fleets: Array<{
    fleet: string;
    instance_count: number;
    metrics: Record<
      string,
      {
        unit: string;
        sum: number;
        average_per_instance: number;
        minimum_per_instance: number;
        maximum_per_instance: number;
        aggregate_average_per_second: number;
        aggregate_average_gib_per_second: number | null;
      }
    >;
  }>;
}): string {
  const lines = [
    "# EC2 Network Traffic Metrics",
    "",
    `Window: ${summary.metric_window.started_at} to ${summary.metric_window.ended_at} (${format(summary.metric_window.duration_seconds)} seconds).`,
    "",
    "| Fleet | Instances | Metric | Unit | Sum | Avg/instance | Min/instance | Max/instance | Aggregate/sec | Aggregate GiB/sec |",
    "|---|---:|---|---|---:|---:|---:|---:|---:|---:|",
    ...summary.fleets.flatMap((fleet) =>
      Object.entries(fleet.metrics).map(
        ([metric, values]) =>
          `| \`${fleet.fleet}\` | ${fleet.instance_count} | ${metric} | ${values.unit} | ${format(values.sum)} | ${format(values.average_per_instance)} | ${format(values.minimum_per_instance)} | ${format(values.maximum_per_instance)} | ${format(values.aggregate_average_per_second)} | ${values.aggregate_average_gib_per_second === null ? "n/a" : format(values.aggregate_average_gib_per_second)} |`
      )
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
