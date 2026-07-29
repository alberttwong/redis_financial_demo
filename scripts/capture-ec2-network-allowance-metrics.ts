import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

type Dimension = {
  Name: string;
  Value: string;
};

type ListedMetric = {
  Namespace?: string;
  MetricName?: string;
  Dimensions?: Dimension[];
};

type CloudWatchResult = {
  Id: string;
  Label?: string;
  Timestamps?: string[];
  Values?: number[];
  StatusCode?: string;
  Messages?: Array<{ Code?: string; Value?: string }>;
};

type MetricDefinition = {
  key: string;
  metricName: string;
  label: string;
};

export type CounterSeries = {
  id: string;
  fleet: string;
  instanceId: string;
  metricKey: string;
  metricName: string;
  dimensions: Dimension[];
  result?: CloudWatchResult;
};

type CounterSeriesSummary = {
  dimensions: Dimension[];
  status: "complete" | "missing_baseline" | "missing_final" | "missing";
  delta_packets: number | null;
  reset_count: number;
  baseline: { timestamp: string; value: number } | null;
  final: { timestamp: string; value: number } | null;
  datapoints: Array<{ timestamp: string; value: number }>;
  cloudwatch_status: string;
  messages: Array<{ Code?: string; Value?: string }>;
};

type InstanceMetricSummary = {
  label: string;
  delta_packets: number | null;
  status: "complete" | "partial" | "missing";
  series_count: number;
  complete_series_count: number;
  series: CounterSeriesSummary[];
};

type InstanceSummary = {
  instance_id: string;
  status: "complete" | "partial" | "missing";
  metrics: Record<string, InstanceMetricSummary>;
};

type FleetMetricSummary = {
  label: string;
  instance_count: number;
  reporting_instances: number;
  affected_instances: number;
  missing_instances: number;
  partial_instances: number;
  sum_delta_packets: number | null;
  average_delta_packets: number | null;
  minimum_delta_packets: number | null;
  maximum_delta_packets: number | null;
};

export type NetworkAllowanceSummary = {
  experiment: "ec2-network-allowance-metrics";
  captured_at: string;
  namespace: "CWAgent";
  metric_window: {
    started_at: string;
    ended_at: string;
    query_started_at: string;
    query_ended_at: string;
    period_seconds: 60;
  };
  verdict: "allowance_exceeded" | "no_allowance_exceeded" | "inconclusive";
  any_allowance_exceeded: boolean;
  telemetry_complete: boolean;
  coverage: {
    expected_instance_metric_pairs: number;
    complete_instance_metric_pairs: number;
    partial_instance_metric_pairs: number;
    missing_instance_metric_pairs: number;
  };
  fleets: Array<{
    fleet: string;
    instance_count: number;
    metrics: Record<string, FleetMetricSummary>;
    instances: InstanceSummary[];
  }>;
};

const execFileAsync = promisify(execFile);
const PERIOD_SECONDS = 60;
const QUERY_PADDING_SECONDS = 120;
const QUERY_BATCH_SIZE = 400;

export const NETWORK_ALLOWANCE_METRICS: MetricDefinition[] = [
  {
    key: "bandwidth_in_allowance_exceeded",
    metricName: "ethtool_bw_in_allowance_exceeded",
    label: "Inbound bandwidth"
  },
  {
    key: "bandwidth_out_allowance_exceeded",
    metricName: "ethtool_bw_out_allowance_exceeded",
    label: "Outbound bandwidth"
  },
  {
    key: "pps_allowance_exceeded",
    metricName: "ethtool_pps_allowance_exceeded",
    label: "Packet rate"
  },
  {
    key: "conntrack_allowance_exceeded",
    metricName: "ethtool_conntrack_allowance_exceeded",
    label: "Connection tracking"
  },
  {
    key: "linklocal_allowance_exceeded",
    metricName: "ethtool_linklocal_allowance_exceeded",
    label: "Link-local packet rate"
  }
];

async function main(): Promise<void> {
  const [startedAt, endedAt, fleetJson, outputDirectory] = process.argv.slice(2);
  if (!startedAt || !endedAt || !fleetJson || !outputDirectory) {
    throw new Error(
      "Usage: capture-ec2-network-allowance-metrics.ts <start-iso> <end-iso> <fleet-instance-ids-json> <output-directory>"
    );
  }
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
    throw new Error("The metric window must contain valid ISO timestamps with end after start.");
  }
  const fleets = normalizeFleets(
    JSON.parse(fleetJson) as Record<string, unknown>
  );
  if (Object.values(fleets).flat().length === 0) {
    throw new Error("At least one EC2 instance ID is required.");
  }

  const queryStartedAt = new Date(
    startedMs - QUERY_PADDING_SECONDS * 1_000
  ).toISOString();
  const queryEndedAt = new Date(
    endedMs + QUERY_PADDING_SECONDS * 1_000
  ).toISOString();
  await mkdir(outputDirectory, { recursive: true });

  const series = await discoverSeries(fleets);
  const queries = series.map((entry) => ({
    Id: entry.id,
    Label: `${entry.fleet}:${entry.instanceId}:${entry.metricKey}`,
    MetricStat: {
      Metric: {
        Namespace: "CWAgent",
        MetricName: entry.metricName,
        Dimensions: entry.dimensions
      },
      Period: PERIOD_SECONDS,
      Stat: "Maximum"
    },
    ReturnData: true
  }));
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "ec2-network-allowance-metric-series.json"),
      `${JSON.stringify(series.map(({ result: _result, ...entry }) => entry), null, 2)}\n`
    ),
    writeFile(
      path.join(outputDirectory, "ec2-network-allowance-metric-queries.json"),
      `${JSON.stringify(queries, null, 2)}\n`
    )
  ]);

  const batchResponses: Array<{
    batch: number;
    query_count: number;
    response: { MetricDataResults?: CloudWatchResult[] };
  }> = [];
  for (let offset = 0; offset < queries.length; offset += QUERY_BATCH_SIZE) {
    const batch = queries.slice(offset, offset + QUERY_BATCH_SIZE);
    const batchNumber = Math.floor(offset / QUERY_BATCH_SIZE) + 1;
    const batchPath = path.join(
      outputDirectory,
      `ec2-network-allowance-metric-queries-batch-${String(batchNumber).padStart(2, "0")}.json`
    );
    await writeFile(batchPath, `${JSON.stringify(batch, null, 2)}\n`);
    const response = await awsJson<{ MetricDataResults?: CloudWatchResult[] }>([
      "cloudwatch",
      "get-metric-data",
      "--region",
      process.env.AWS_REGION ?? "us-west-2",
      "--start-time",
      queryStartedAt,
      "--end-time",
      queryEndedAt,
      "--scan-by",
      "TimestampAscending",
      "--metric-data-queries",
      `file://${batchPath}`,
      "--output",
      "json"
    ]);
    batchResponses.push({ batch: batchNumber, query_count: batch.length, response });
  }

  const resultsById = new Map(
    batchResponses.flatMap((batch) =>
      (batch.response.MetricDataResults ?? []).map(
        (result) => [result.Id, result] as const
      )
    )
  );
  const capturedSeries = series.map((entry) => ({
    ...entry,
    result: resultsById.get(entry.id)
  }));
  const summary = summarizeNetworkAllowanceMetrics({
    startedAt,
    endedAt,
    queryStartedAt,
    queryEndedAt,
    fleets,
    series: capturedSeries
  });

  const jsonPath = path.join(
    outputDirectory,
    "ec2-network-allowance-metrics.json"
  );
  const markdownPath = path.join(
    outputDirectory,
    "ec2-network-allowance-metrics.md"
  );
  await Promise.all([
    writeFile(
      path.join(outputDirectory, "ec2-network-allowance-cloudwatch-raw.json"),
      `${JSON.stringify({ batch_responses: batchResponses }, null, 2)}\n`
    ),
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, renderNetworkAllowanceMarkdown(summary))
  ]);
  process.stdout.write(renderNetworkAllowanceMarkdown(summary));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

async function discoverSeries(
  fleets: Record<string, string[]>
): Promise<CounterSeries[]> {
  const fleetByInstance = new Map<string, string>();
  for (const [fleet, instanceIds] of Object.entries(fleets)) {
    for (const instanceId of instanceIds) {
      if (fleetByInstance.has(instanceId)) {
        throw new Error(`EC2 instance ${instanceId} is assigned to multiple fleets.`);
      }
      fleetByInstance.set(instanceId, fleet);
    }
  }

  const discovered: Array<Omit<CounterSeries, "id">> = [];
  for (const definition of NETWORK_ALLOWANCE_METRICS) {
    const response = await awsJson<{ Metrics?: ListedMetric[] }>([
      "cloudwatch",
      "list-metrics",
      "--region",
      process.env.AWS_REGION ?? "us-west-2",
      "--namespace",
      "CWAgent",
      "--metric-name",
      definition.metricName,
      "--dimensions",
      "Name=InstanceId",
      "--recently-active",
      "PT3H",
      "--output",
      "json"
    ]);
    const candidatesByInstance = new Map<string, Dimension[][]>();
    for (const metric of response.Metrics ?? []) {
      const dimensions = [...(metric.Dimensions ?? [])].sort(compareDimensions);
      const instanceId = dimensions.find(
        (dimension) => dimension.Name === "InstanceId"
      )?.Value;
      if (!instanceId || !fleetByInstance.has(instanceId)) continue;
      candidatesByInstance.set(instanceId, [
        ...(candidatesByInstance.get(instanceId) ?? []),
        dimensions
      ]);
    }
    for (const [instanceId, fleet] of fleetByInstance) {
      const candidates = candidatesByInstance.get(instanceId) ?? [];
      const perInstance = candidates.filter(
        (dimensions) =>
          dimensions.length === 1 && dimensions[0]?.Name === "InstanceId"
      );
      const selected =
        perInstance.length > 0
          ? perInstance
          : candidates.length > 0
            ? candidates
            : [[{ Name: "InstanceId", Value: instanceId }]];
      for (const dimensions of selected) {
        discovered.push({
          fleet,
          instanceId,
          metricKey: definition.key,
          metricName: definition.metricName,
          dimensions
        });
      }
    }
  }

  return uniqueSeries(discovered)
    .sort((left, right) =>
      [
        left.fleet,
        left.instanceId,
        left.metricKey,
        JSON.stringify(left.dimensions)
      ]
        .join(":")
        .localeCompare(
          [
            right.fleet,
            right.instanceId,
            right.metricKey,
            JSON.stringify(right.dimensions)
          ].join(":")
        )
    )
    .map((entry, index) => ({
      id: `m${String(index + 1).padStart(6, "0")}`,
      ...entry
    }));
}

function uniqueSeries(
  series: Array<Omit<CounterSeries, "id">>
): Array<Omit<CounterSeries, "id">> {
  return [
    ...new Map(
      series.map((entry) => [
        `${entry.metricName}:${JSON.stringify(entry.dimensions)}`,
        entry
      ])
    ).values()
  ];
}

export function summarizeNetworkAllowanceMetrics(input: {
  startedAt: string;
  endedAt: string;
  queryStartedAt?: string;
  queryEndedAt?: string;
  fleets: Record<string, string[]>;
  series: CounterSeries[];
  capturedAt?: string;
}): NetworkAllowanceSummary {
  const startedMs = Date.parse(input.startedAt);
  const endedMs = Date.parse(input.endedAt);
  const fleets = Object.entries(normalizeFleets(input.fleets))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fleet, instanceIds]) => {
      const instances = instanceIds.map((instanceId) =>
        summarizeInstance(fleet, instanceId, input.series, startedMs, endedMs)
      );
      return {
        fleet,
        instance_count: instances.length,
        metrics: Object.fromEntries(
          NETWORK_ALLOWANCE_METRICS.map((definition) => [
            definition.key,
            summarizeFleetMetric(definition, instances)
          ])
        ),
        instances
      };
    });
  const instanceMetrics = fleets.flatMap((fleet) =>
    fleet.instances.flatMap((instance) => Object.values(instance.metrics))
  );
  const complete = instanceMetrics.filter(
    (metric) => metric.status === "complete"
  ).length;
  const partial = instanceMetrics.filter(
    (metric) => metric.status === "partial"
  ).length;
  const missing = instanceMetrics.filter(
    (metric) => metric.status === "missing"
  ).length;
  const anyExceeded = instanceMetrics.some(
    (metric) => (metric.delta_packets ?? 0) > 0
  );
  const telemetryComplete = partial === 0 && missing === 0;
  return {
    experiment: "ec2-network-allowance-metrics",
    captured_at: input.capturedAt ?? new Date().toISOString(),
    namespace: "CWAgent",
    metric_window: {
      started_at: input.startedAt,
      ended_at: input.endedAt,
      query_started_at: input.queryStartedAt ?? input.startedAt,
      query_ended_at: input.queryEndedAt ?? input.endedAt,
      period_seconds: PERIOD_SECONDS
    },
    verdict: anyExceeded
      ? "allowance_exceeded"
      : telemetryComplete
        ? "no_allowance_exceeded"
        : "inconclusive",
    any_allowance_exceeded: anyExceeded,
    telemetry_complete: telemetryComplete,
    coverage: {
      expected_instance_metric_pairs: instanceMetrics.length,
      complete_instance_metric_pairs: complete,
      partial_instance_metric_pairs: partial,
      missing_instance_metric_pairs: missing
    },
    fleets
  };
}

function summarizeInstance(
  fleet: string,
  instanceId: string,
  series: CounterSeries[],
  startedMs: number,
  endedMs: number
): InstanceSummary {
  const metrics = Object.fromEntries(
    NETWORK_ALLOWANCE_METRICS.map((definition) => {
      const matching = series.filter(
        (entry) =>
          entry.fleet === fleet &&
          entry.instanceId === instanceId &&
          entry.metricKey === definition.key
      );
      const summaries = matching.map((entry) =>
        summarizeCounterSeries(entry, startedMs, endedMs)
      );
      const complete = summaries.filter(
        (summary) => summary.status === "complete"
      );
      const status =
        summaries.length === 0 ||
        summaries.every((summary) => summary.status === "missing")
          ? "missing"
          : complete.length === summaries.length
            ? "complete"
            : "partial";
      return [
        definition.key,
        {
          label: definition.label,
          delta_packets:
            complete.length === 0
              ? null
              : round(
                  complete.reduce(
                    (total, summary) => total + (summary.delta_packets ?? 0),
                    0
                  )
                ),
          status,
          series_count: summaries.length,
          complete_series_count: complete.length,
          series: summaries
        } satisfies InstanceMetricSummary
      ];
    })
  );
  const statuses = Object.values(metrics).map((metric) => metric.status);
  return {
    instance_id: instanceId,
    status: statuses.every((status) => status === "complete")
      ? "complete"
      : statuses.every((status) => status === "missing")
        ? "missing"
        : "partial",
    metrics
  };
}

function summarizeCounterSeries(
  series: CounterSeries,
  startedMs: number,
  endedMs: number
): CounterSeriesSummary {
  const result = series.result;
  const points = (result?.Timestamps ?? [])
    .map((timestamp, index) => ({
      timestamp,
      timestampMs: Date.parse(timestamp),
      value: result?.Values?.[index]
    }))
    .filter(
      (
        point
      ): point is { timestamp: string; timestampMs: number; value: number } =>
        Number.isFinite(point.timestampMs) && Number.isFinite(point.value)
    )
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const baselineIndex = findLastIndex(
    points,
    (point) => point.timestampMs <= startedMs
  );
  const finalIndex = points.findIndex((point) => point.timestampMs >= endedMs);
  let status: CounterSeriesSummary["status"] = "complete";
  if (points.length === 0) status = "missing";
  else if (baselineIndex < 0) status = "missing_baseline";
  else if (finalIndex < 0) status = "missing_final";

  const baseline = baselineIndex >= 0 ? points[baselineIndex] : undefined;
  const final = finalIndex >= 0 ? points[finalIndex] : undefined;
  const selected =
    baseline && final
      ? points.slice(baselineIndex, finalIndex + 1)
      : [];
  const delta = selected.length >= 2 ? counterDelta(selected.map((point) => point.value)) : null;
  return {
    dimensions: series.dimensions,
    status,
    delta_packets: delta?.delta ?? null,
    reset_count: delta?.resets ?? 0,
    baseline: baseline
      ? { timestamp: baseline.timestamp, value: baseline.value }
      : null,
    final: final ? { timestamp: final.timestamp, value: final.value } : null,
    datapoints: points.map(({ timestamp, value }) => ({ timestamp, value })),
    cloudwatch_status: result?.StatusCode ?? "Missing",
    messages: result?.Messages ?? []
  };
}

function summarizeFleetMetric(
  definition: MetricDefinition,
  instances: InstanceSummary[]
): FleetMetricSummary {
  const instanceMetrics = instances.map(
    (instance) => instance.metrics[definition.key]
  );
  const values = instanceMetrics.flatMap((metric) =>
    metric.delta_packets === null ? [] : [metric.delta_packets]
  );
  return {
    label: definition.label,
    instance_count: instances.length,
    reporting_instances: values.length,
    affected_instances: values.filter((value) => value > 0).length,
    missing_instances: instanceMetrics.filter(
      (metric) => metric.status === "missing"
    ).length,
    partial_instances: instanceMetrics.filter(
      (metric) => metric.status === "partial"
    ).length,
    sum_delta_packets:
      values.length === 0
        ? null
        : round(values.reduce((total, value) => total + value, 0)),
    average_delta_packets:
      values.length === 0
        ? null
        : round(values.reduce((total, value) => total + value, 0) / values.length),
    minimum_delta_packets:
      values.length === 0 ? null : round(Math.min(...values)),
    maximum_delta_packets:
      values.length === 0 ? null : round(Math.max(...values))
  };
}

function counterDelta(values: number[]): { delta: number; resets: number } {
  let delta = 0;
  let resets = 0;
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (current >= previous) {
      delta += current - previous;
    } else {
      resets += 1;
      delta += current;
    }
  }
  return { delta: round(delta), resets };
}

function normalizeFleets(input: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(input).map(([fleet, value]) => {
      if (!Array.isArray(value)) {
        throw new Error(`Fleet ${fleet} must be an array of EC2 instance IDs.`);
      }
      const instanceIds = [
        ...new Set(
          value.map((instanceId) => {
            if (typeof instanceId !== "string" || !instanceId.trim()) {
              throw new Error(`Fleet ${fleet} contains an invalid EC2 instance ID.`);
            }
            return instanceId.trim();
          })
        )
      ].sort();
      return [fleet, instanceIds];
    })
  );
}

export function renderNetworkAllowanceMarkdown(
  summary: NetworkAllowanceSummary
): string {
  const verdict =
    summary.verdict === "allowance_exceeded"
      ? "AWS network allowance pressure was detected."
      : summary.verdict === "no_allowance_exceeded"
        ? "No EC2 network allowance counter increased during the load window."
        : "No exceedance can be ruled in or out because telemetry is incomplete.";
  const lines = [
    "# EC2 Network Allowance Metrics",
    "",
    `Verdict: **${verdict}**`,
    "",
    `Benchmark window: ${summary.metric_window.started_at} to ${summary.metric_window.ended_at}.`,
    "",
    `Coverage: ${summary.coverage.complete_instance_metric_pairs}/${summary.coverage.expected_instance_metric_pairs} instance-metric pairs complete; ${summary.coverage.partial_instance_metric_pairs} partial; ${summary.coverage.missing_instance_metric_pairs} missing.`,
    "",
    "These ENA metrics are cumulative counters. Values below are counter increases across the benchmark window, not sums of the raw CloudWatch samples.",
    "",
    "| Fleet | Instances | Allowance | Reporting | Affected | Sum increase | Average/instance | Minimum | Maximum |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|"
  ];
  for (const fleet of summary.fleets) {
    for (const definition of NETWORK_ALLOWANCE_METRICS) {
      const metric = fleet.metrics[definition.key];
      lines.push(
        `| \`${fleet.fleet}\` | ${fleet.instance_count} | ${metric.label} | ${metric.reporting_instances} | ${metric.affected_instances} | ${formatOptional(metric.sum_delta_packets)} | ${formatOptional(metric.average_delta_packets)} | ${formatOptional(metric.minimum_delta_packets)} | ${formatOptional(metric.maximum_delta_packets)} |`
      );
    }
  }
  lines.push(
    "",
    "## Per-instance counter increases",
    "",
    "| Fleet | Instance | Inbound BW | Outbound BW | PPS | Conntrack | Link-local | Telemetry |",
    "|---|---|---:|---:|---:|---:|---:|---|"
  );
  for (const fleet of summary.fleets) {
    for (const instance of fleet.instances) {
      const value = (key: string) =>
        formatOptional(instance.metrics[key]?.delta_packets ?? null);
      lines.push(
        `| \`${fleet.fleet}\` | \`${instance.instance_id}\` | ${value("bandwidth_in_allowance_exceeded")} | ${value("bandwidth_out_allowance_exceeded")} | ${value("pps_allowance_exceeded")} | ${value("conntrack_allowance_exceeded")} | ${value("linklocal_allowance_exceeded")} | ${instance.status} |`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function awsJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("aws", args, {
    maxBuffer: 50 * 1024 * 1024
  });
  return JSON.parse(stdout) as T;
}

function compareDimensions(left: Dimension, right: Dimension): number {
  return `${left.Name}:${left.Value}`.localeCompare(`${right.Name}:${right.Value}`);
}

function findLastIndex<T>(
  values: T[],
  predicate: (value: T) => boolean
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index;
  }
  return -1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatOptional(value: number | null): string {
  return value === null
    ? "n/a"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
