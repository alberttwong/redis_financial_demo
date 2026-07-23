import { execFile } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const SELECTED_METRICS = new Set([
  "bdb_up",
  "bdb_instantaneous_ops_per_sec",
  "bdb_total_req",
  "bdb_read_req",
  "bdb_write_req",
  "bdb_other_req",
  "bdb_avg_latency",
  "bdb_avg_read_latency",
  "bdb_avg_write_latency",
  "bdb_avg_other_latency",
  "bdb_conns",
  "bdb_total_connections_received",
  "bdb_ingress_bytes",
  "bdb_egress_bytes",
  "bdb_used_memory",
  "bdb_memory_limit",
  "bdb_no_of_keys",
  "bdb_evicted_objects",
  "bdb_expired_objects",
  "bdb_read_hits",
  "bdb_read_misses",
  "bdb_mem_frag_ratio",
  "bdb_main_thread_cpu_user",
  "bdb_main_thread_cpu_system",
  "bdb_shard_cpu_user",
  "bdb_shard_cpu_system",
  "bdb_shards_used",
  "listener_conns",
  "listener_max_connections_exceeded"
]);

const execFileAsync = promisify(execFile);
const [endpoint, databaseId, databaseName = "", outputPath, interval = "15000"] =
  process.argv.slice(2);

if (!endpoint || !databaseId || !outputPath) {
  throw new Error(
    "Usage: capture-redis-cloud-prometheus.ts <endpoint> <database-id> <database-name> <output-ndjson-path> [poll-interval-ms]"
  );
}

const intervalMs = positiveInteger(interval, "poll interval");
const scrapeUrl = normalizeScrapeUrl(endpoint);
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "");
  while (!stopping) {
    const startedAt = performance.now();
    const capturedAt = new Date().toISOString();
    try {
      const { stdout } = await execFileAsync(
        "curl",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--connect-timeout",
          "5",
          "--max-time",
          "20",
          ...(process.env.REDISCLOUD_PROMETHEUS_INSECURE_TLS === "1"
            ? ["--insecure"]
            : []),
          scrapeUrl
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );
      const metrics = selectDatabaseMetrics(stdout, databaseId, databaseName);
      if (Object.keys(metrics).length === 0) {
        throw new Error(
          `Prometheus scrape succeeded but returned no selected metrics for Redis Cloud database ${databaseId}`
        );
      }
      await appendSample({
        captured_at: capturedAt,
        scrape_duration_ms: round(performance.now() - startedAt),
        scrape_url: scrapeUrl,
        status: "ok",
        metrics
      });
    } catch (error) {
      await appendSample({
        captured_at: capturedAt,
        scrape_duration_ms: round(performance.now() - startedAt),
        scrape_url: scrapeUrl,
        status: "error",
        error: error instanceof Error ? error.message.slice(0, 1_000) : String(error)
      });
    }
    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

function selectDatabaseMetrics(
  exposition: string,
  expectedDatabaseId: string,
  expectedDatabaseName: string
) {
  const selected: Record<string, Array<{ labels: Record<string, string>; value: number }>> =
    {};
  for (const line of exposition.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parsed = parseMetricLine(line);
    if (!parsed || !SELECTED_METRICS.has(parsed.name)) continue;
    if (!matchesDatabase(parsed.labels, expectedDatabaseId, expectedDatabaseName)) continue;
    (selected[parsed.name] ??= []).push({
      labels: parsed.labels,
      value: parsed.value
    });
  }
  return selected;
}

function parseMetricLine(line: string) {
  const match = line.match(
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+([^\s]+)(?:\s+\d+)?$/
  );
  if (!match) return null;
  const value = Number(match[3]);
  if (!Number.isFinite(value)) return null;
  return {
    name: match[1],
    labels: parseLabels(match[2] ?? ""),
    value
  };
}

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;
  for (const match of raw.matchAll(pattern)) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return labels;
}

function matchesDatabase(
  labels: Record<string, string>,
  expectedDatabaseId: string,
  expectedDatabaseName: string
): boolean {
  const candidates = [
    labels.bdb,
    labels.db,
    labels.database,
    labels.database_id,
    labels.db_id,
    labels.bdb_uid
  ].filter((value): value is string => Boolean(value));
  return candidates.some(
    (value) =>
      value === expectedDatabaseId ||
      (expectedDatabaseName !== "" && value === expectedDatabaseName) ||
      value.endsWith(`:${expectedDatabaseId}`) ||
      value.endsWith(`-${expectedDatabaseId}`)
  );
}

function normalizeScrapeUrl(value: string): string {
  const withScheme = /^https?:\/\//.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  if (!url.port) url.port = "8070";
  // The summarizer consumes Redis Cloud's aggregate v1 database gauges.
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function appendSample(sample: object): Promise<void> {
  await appendFile(outputPath, `${JSON.stringify(sample)}\n`);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
