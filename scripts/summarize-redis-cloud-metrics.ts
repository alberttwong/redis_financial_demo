import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type MetricSeries = {
  labels: Record<string, string>;
  value: number;
};

type MetricSample = {
  captured_at: string;
  status: "ok" | "error";
  error?: string;
  metrics?: Record<string, MetricSeries[]>;
};

type Distribution = {
  samples: number;
  average: number;
  p95: number;
  max: number;
  latest: number;
};

type MetricDefinition = {
  name: string;
  label: string;
  unit: string;
  scale?: number;
};

const METRICS: MetricDefinition[] = [
  { name: "bdb_instantaneous_ops_per_sec", label: "Operations", unit: "ops/sec" },
  { name: "bdb_read_req", label: "Read requests", unit: "ops/sec" },
  { name: "bdb_write_req", label: "Write requests", unit: "ops/sec" },
  { name: "bdb_other_req", label: "Other requests", unit: "ops/sec" },
  { name: "bdb_avg_latency", label: "Overall latency", unit: "ms", scale: 1_000 },
  { name: "bdb_avg_read_latency", label: "Read latency", unit: "ms", scale: 1_000 },
  { name: "bdb_avg_write_latency", label: "Write latency", unit: "ms", scale: 1_000 },
  { name: "bdb_avg_other_latency", label: "Other latency", unit: "ms", scale: 1_000 },
  { name: "bdb_conns", label: "Connections", unit: "connections" },
  {
    name: "bdb_total_connections_received",
    label: "New connections",
    unit: "connections/sec"
  },
  {
    name: "bdb_ingress_bytes",
    label: "Network ingress",
    unit: "MiB/sec",
    scale: 1 / 1024 / 1024
  },
  {
    name: "bdb_egress_bytes",
    label: "Network egress",
    unit: "MiB/sec",
    scale: 1 / 1024 / 1024
  },
  {
    name: "bdb_main_thread_cpu_user",
    label: "Main-thread CPU user",
    unit: "% cores"
  },
  {
    name: "bdb_main_thread_cpu_system",
    label: "Main-thread CPU system",
    unit: "% cores"
  },
  { name: "bdb_shard_cpu_user", label: "Shard CPU user", unit: "% cores" },
  { name: "bdb_shard_cpu_system", label: "Shard CPU system", unit: "% cores" },
  {
    name: "bdb_used_memory",
    label: "Used memory",
    unit: "GiB",
    scale: 1 / 1024 / 1024 / 1024
  },
  {
    name: "bdb_memory_limit",
    label: "Memory limit",
    unit: "GiB",
    scale: 1 / 1024 / 1024 / 1024
  },
  { name: "bdb_mem_frag_ratio", label: "Memory fragmentation", unit: "ratio" },
  { name: "bdb_evicted_objects", label: "Evictions", unit: "objects/sec" },
  { name: "bdb_expired_objects", label: "Expirations", unit: "objects/sec" },
  { name: "bdb_no_of_keys", label: "Keys", unit: "keys" },
  { name: "bdb_shards_used", label: "Shards used", unit: "shards" },
  {
    name: "listener_max_connections_exceeded",
    label: "Connection-limit exceedances",
    unit: "events"
  },
  { name: "bdb_up", label: "Database up", unit: "boolean" }
];

async function main() {
  const [inputPath, outputDirectory] = process.argv.slice(2);
  if (!inputPath || !outputDirectory) {
    throw new Error(
      "Usage: summarize-redis-cloud-metrics.ts <input-ndjson-path> <output-directory>"
    );
  }
  const samples = (await readFile(inputPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as MetricSample];
      } catch {
        return [];
      }
    });
  const successful = samples.filter(
    (sample): sample is MetricSample & { metrics: Record<string, MetricSeries[]> } =>
      sample.status === "ok" && Boolean(sample.metrics)
  );
  const metrics = Object.fromEntries(
    METRICS.map((metric) => {
      const values = successful.flatMap((sample) => {
        const series = sample.metrics[metric.name];
        if (!series || series.length === 0) return [];
        return [
          series.reduce((total, value) => total + value.value, 0) *
            (metric.scale ?? 1)
        ];
      });
      return [
        metric.name,
        {
          label: metric.label,
          unit: metric.unit,
          ...distribution(values)
        }
      ];
    })
  );
  const memoryUtilization = derivedRatio(
    successful,
    "bdb_used_memory",
    "bdb_memory_limit",
    100
  );
  const hitRatio = derivedHitRatio(successful);
  const summary = {
    experiment: "redis-cloud-prometheus",
    generated_at: new Date().toISOString(),
    captured_samples: samples.length,
    successful_samples: successful.length,
    failed_samples: samples.length - successful.length,
    started_at: samples.at(0)?.captured_at ?? null,
    ended_at: samples.at(-1)?.captured_at ?? null,
    errors: [
      ...new Set(
        samples.flatMap((sample) =>
          sample.status === "error" && sample.error ? [sample.error] : []
        )
      )
    ],
    derived: {
      memory_utilization_percent: memoryUtilization,
      read_hit_ratio_percent: hitRatio
    },
    metrics
  };
  const jsonPath = path.join(outputDirectory, "redis-cloud-metrics-summary.json");
  const markdownPath = path.join(outputDirectory, "redis-cloud-metrics-summary.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(summary))
  ]);
  process.stdout.write(renderMarkdown(summary));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

function derivedRatio(
  samples: Array<MetricSample & { metrics: Record<string, MetricSeries[]> }>,
  numerator: string,
  denominator: string,
  scale: number
): Distribution {
  return distribution(
    samples.flatMap((sample) => {
      const top = sumSeries(sample.metrics[numerator]);
      const bottom = sumSeries(sample.metrics[denominator]);
      return bottom > 0 ? [(top / bottom) * scale] : [];
    })
  );
}

function derivedHitRatio(
  samples: Array<MetricSample & { metrics: Record<string, MetricSeries[]> }>
): Distribution {
  return distribution(
    samples.flatMap((sample) => {
      const hits = sumSeries(sample.metrics.bdb_read_hits);
      const misses = sumSeries(sample.metrics.bdb_read_misses);
      return hits + misses > 0 ? [(hits / (hits + misses)) * 100] : [];
    })
  );
}

function sumSeries(series: MetricSeries[] | undefined): number {
  return (series ?? []).reduce((total, value) => total + value.value, 0);
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) {
    return { samples: 0, average: 0, p95: 0, max: 0, latest: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    average: round(values.reduce((total, value) => total + value, 0) / values.length),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]),
    max: round(sorted.at(-1) ?? 0),
    latest: round(values.at(-1) ?? 0)
  };
}

function renderMarkdown(summary: {
  captured_samples: number;
  successful_samples: number;
  failed_samples: number;
  errors: string[];
  derived: Record<string, Distribution>;
  metrics: Record<string, Distribution & { label: string; unit: string }>;
}): string {
  const available = Object.values(summary.metrics).filter((metric) => metric.samples > 0);
  const lines = [
    "# Redis Cloud Metrics",
    "",
    `Scrapes: ${summary.successful_samples}/${summary.captured_samples} successful; ${summary.failed_samples} failed.`,
    "",
    "| Metric | Unit | Average | p95 | Maximum | Latest |",
    "|---|---|---:|---:|---:|---:|",
    ...available.map(
      (metric) =>
        `| ${metric.label} | ${metric.unit} | ${format(metric.average)} | ${format(metric.p95)} | ${format(metric.max)} | ${format(metric.latest)} |`
    ),
    ...(summary.derived.memory_utilization_percent.samples > 0
      ? [
          `| Memory utilization | % | ${format(summary.derived.memory_utilization_percent.average)} | ${format(summary.derived.memory_utilization_percent.p95)} | ${format(summary.derived.memory_utilization_percent.max)} | ${format(summary.derived.memory_utilization_percent.latest)} |`
        ]
      : []),
    ...(summary.derived.read_hit_ratio_percent.samples > 0
      ? [
          `| Read hit ratio | % | ${format(summary.derived.read_hit_ratio_percent.average)} | ${format(summary.derived.read_hit_ratio_percent.p95)} | ${format(summary.derived.read_hit_ratio_percent.max)} | ${format(summary.derived.read_hit_ratio_percent.latest)} |`
        ]
      : []),
    ""
  ];
  if (summary.errors.length > 0) {
    lines.push("## Collection errors", "");
    lines.push(...summary.errors.map((error) => `- ${error}`), "");
  }
  return `${lines.join("\n")}\n`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
