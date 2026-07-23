import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type LatencySummary = {
  samples: number;
  p50: number;
  p95: number;
  p99: number;
  p99_9: number;
};

type QueryResult = {
  pattern: string;
  target_rps: number;
  achieved_rps: number;
  successful_requests?: number;
  dropped_requests: number;
  http_errors: number;
  request_errors: number;
  average_successful_response_bytes?: number;
  average_api_payload_bytes?: number;
  successful_response_megabytes_per_second?: number;
  socket_queue_ms?: {
    p95: number;
  };
  redis_latency_ms?: LatencySummary;
  redis_timing_missing_samples?: number;
  latency_histogram_ms?: Array<[number, number]>;
  redis_latency_histogram_ms?: Array<[number, number]>;
  socket_queue_histogram_ms?: Array<[number, number]>;
  latency_ms: Omit<LatencySummary, "samples">;
};

const PATTERN_ORDER = [
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
];

async function main() {
  const rootDirectory = process.argv[2];
  if (!rootDirectory) {
    throw new Error("Usage: summarize-concurrent-results.ts <concurrent-output-directory>");
  }

  const resultPaths = await findQueryResultPaths(rootDirectory);
  if (resultPaths.length === 0) {
    throw new Error(`No query result files found in ${rootDirectory}.`);
  }

  const results = await Promise.all(
    resultPaths.map(async (resultPath) => JSON.parse(await readFile(resultPath, "utf8")) as QueryResult)
  );
  const byPattern = new Map<string, QueryResult[]>();
  for (const result of results) {
    const patternResults = byPattern.get(result.pattern) ?? [];
    patternResults.push(result);
    byPattern.set(result.pattern, patternResults);
  }

  const queries = [...byPattern.values()]
    .map(aggregateQueryResults)
    .sort(
      (left, right) =>
        patternIndex(left.pattern) - patternIndex(right.pattern) || left.pattern.localeCompare(right.pattern)
    )
    .map((result) => ({
      pattern: result.pattern,
      target_per_second: result.target_rps,
      achieved_per_second: result.achieved_rps,
      p50_latency_ms: result.latency_ms.p50,
      p95_latency_ms: result.latency_ms.p95,
      p99_latency_ms: result.latency_ms.p99,
      redis_timing_samples: result.redis_latency_ms?.samples ?? 0,
      redis_timing_missing_samples: result.redis_timing_missing_samples ?? 0,
      redis_p50_latency_ms: result.redis_latency_ms?.p50 ?? 0,
      redis_p95_latency_ms: result.redis_latency_ms?.p95 ?? 0,
      redis_p99_latency_ms: result.redis_latency_ms?.p99 ?? 0,
      dropped_requests: result.dropped_requests,
      http_errors: result.http_errors,
      request_errors: result.request_errors,
      average_successful_response_bytes: result.average_successful_response_bytes ?? 0,
      average_api_payload_bytes: result.average_api_payload_bytes ?? 0,
      successful_response_megabytes_per_second:
        result.successful_response_megabytes_per_second ?? 0,
      socket_queue_p95_ms: result.socket_queue_ms?.p95 ?? 0
    }));

  const summary = {
    experiment: "concurrent-query-load",
    query_patterns: queries.length,
    target_per_second: round(queries.reduce((total, query) => total + query.target_per_second, 0)),
    achieved_per_second: round(queries.reduce((total, query) => total + query.achieved_per_second, 0)),
    queries
  };
  const markdown = renderMarkdown(summary);
  const jsonPath = path.join(rootDirectory, "concurrent-query-summary.json");
  const markdownPath = path.join(rootDirectory, "concurrent-query-summary.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, markdown)
  ]);

  process.stdout.write(markdown);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

function aggregateQueryResults(results: QueryResult[]): QueryResult {
  if (results.length === 1) return results[0];
  const successfulRequests = results.reduce(
    (total, result) => total + (result.successful_requests ?? result.achieved_rps),
    0
  );
  const latencyHistogram = mergeHistogram(results, "latency_histogram_ms");
  const redisLatencyHistogram = mergeHistogram(results, "redis_latency_histogram_ms");
  const socketQueueHistogram = mergeHistogram(results, "socket_queue_histogram_ms");
  const fallbackLatency = (percentileName: keyof QueryResult["latency_ms"]) =>
    Math.max(...results.map((result) => result.latency_ms[percentileName]));
  const fallbackRedisLatency = (
    percentileName: "p50" | "p95" | "p99" | "p99_9"
  ) =>
    Math.max(
      ...results.map((result) => result.redis_latency_ms?.[percentileName] ?? 0)
    );
  const completeRedisHistograms = results.every((result) =>
    Array.isArray(result.redis_latency_histogram_ms)
  );
  const redisTimingSamples = completeRedisHistograms
    ? histogramSamples(redisLatencyHistogram)
    : results.reduce(
        (total, result) => total + (result.redis_latency_ms?.samples ?? 0),
        0
      );
  return {
    pattern: results[0].pattern,
    target_rps: sum(results, "target_rps"),
    achieved_rps: sum(results, "achieved_rps"),
    successful_requests: successfulRequests,
    dropped_requests: sum(results, "dropped_requests"),
    http_errors: sum(results, "http_errors"),
    request_errors: sum(results, "request_errors"),
    redis_timing_missing_samples: sum(results, "redis_timing_missing_samples"),
    average_successful_response_bytes: weightedAverage(
      results,
      "average_successful_response_bytes",
      successfulRequests
    ),
    average_api_payload_bytes: weightedAverage(results, "average_api_payload_bytes", successfulRequests),
    successful_response_megabytes_per_second: sum(
      results,
      "successful_response_megabytes_per_second"
    ),
    socket_queue_ms: {
      p95:
        socketQueueHistogram.size > 0
          ? percentile(socketQueueHistogram, 0.95)
          : Math.max(...results.map((result) => result.socket_queue_ms?.p95 ?? 0))
    },
    latency_histogram_ms: [...latencyHistogram.entries()],
    redis_latency_histogram_ms: [...redisLatencyHistogram.entries()],
    socket_queue_histogram_ms: [...socketQueueHistogram.entries()],
    redis_latency_ms: {
      samples: redisTimingSamples,
      p50:
        completeRedisHistograms && redisLatencyHistogram.size > 0
          ? percentile(redisLatencyHistogram, 0.5)
          : fallbackRedisLatency("p50"),
      p95:
        completeRedisHistograms && redisLatencyHistogram.size > 0
          ? percentile(redisLatencyHistogram, 0.95)
          : fallbackRedisLatency("p95"),
      p99:
        completeRedisHistograms && redisLatencyHistogram.size > 0
          ? percentile(redisLatencyHistogram, 0.99)
          : fallbackRedisLatency("p99"),
      p99_9:
        completeRedisHistograms && redisLatencyHistogram.size > 0
          ? percentile(redisLatencyHistogram, 0.999)
          : fallbackRedisLatency("p99_9")
    },
    latency_ms: {
      p50: latencyHistogram.size > 0 ? percentile(latencyHistogram, 0.5) : fallbackLatency("p50"),
      p95: latencyHistogram.size > 0 ? percentile(latencyHistogram, 0.95) : fallbackLatency("p95"),
      p99: latencyHistogram.size > 0 ? percentile(latencyHistogram, 0.99) : fallbackLatency("p99"),
      p99_9:
        latencyHistogram.size > 0 ? percentile(latencyHistogram, 0.999) : fallbackLatency("p99_9")
    }
  };
}

function mergeHistogram(
  results: QueryResult[],
  key:
    | "latency_histogram_ms"
    | "redis_latency_histogram_ms"
    | "socket_queue_histogram_ms"
): Map<number, number> {
  const aggregate = new Map<number, number>();
  for (const result of results) {
    for (const [value, count] of result[key] ?? []) {
      aggregate.set(value, (aggregate.get(value) ?? 0) + count);
    }
  }
  return aggregate;
}

function histogramSamples(histogram: Map<number, number>): number {
  return [...histogram.values()].reduce((total, count) => total + count, 0);
}

function percentile(histogram: Map<number, number>, ratio: number): number {
  const samples = histogramSamples(histogram);
  if (samples === 0) return 0;
  const rank = Math.max(1, Math.ceil(samples * ratio));
  let cumulative = 0;
  for (const [value, count] of [...histogram.entries()].sort(([left], [right]) => left - right)) {
    cumulative += count;
    if (cumulative >= rank) return value;
  }
  return Math.max(...histogram.keys());
}

function weightedAverage(
  results: QueryResult[],
  key: "average_successful_response_bytes" | "average_api_payload_bytes",
  totalWeight: number
): number {
  if (totalWeight === 0) return 0;
  return round(
    results.reduce(
      (total, result) =>
        total + (result[key] ?? 0) * (result.successful_requests ?? result.achieved_rps),
      0
    ) / totalWeight
  );
}

function sum(
  results: QueryResult[],
  key:
    | "target_rps"
    | "achieved_rps"
    | "dropped_requests"
    | "http_errors"
    | "request_errors"
    | "redis_timing_missing_samples"
    | "successful_response_megabytes_per_second"
): number {
  return round(
    results.reduce((total, result) => {
      const value = result[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0)
  );
}

async function findQueryResultPaths(rootDirectory: string): Promise<string[]> {
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && /^query-.+\.json$/.test(entry.name))
    .map((entry) => path.join(rootDirectory, entry.name));

  const hostDirectories = entries
    .filter((entry) => entry.isDirectory() && /^host-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const directory of hostDirectories) {
    const hostDirectory = path.join(rootDirectory, directory);
    const hostEntries = await readdir(hostDirectory, { withFileTypes: true });
    for (const entry of hostEntries) {
      if (entry.isFile() && /^query-.+\.json$/.test(entry.name)) {
        paths.push(path.join(hostDirectory, entry.name));
      }
    }
  }
  return paths.sort();
}

function renderMarkdown(summary: {
  query_patterns: number;
  target_per_second: number;
  achieved_per_second: number;
  queries: Array<{
    pattern: string;
    target_per_second: number;
    achieved_per_second: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    redis_timing_samples: number;
    redis_timing_missing_samples: number;
    redis_p50_latency_ms: number;
    redis_p95_latency_ms: number;
    redis_p99_latency_ms: number;
    average_api_payload_bytes: number;
    successful_response_megabytes_per_second: number;
    socket_queue_p95_ms: number;
  }>;
}): string {
  const lines = [
    "# Concurrent Query Results",
    "",
    "| Query pattern | Target/sec | Achieved/sec | HTTP p50/p95/p99 ms | Redis p50/p95/p99 ms | Redis samples/missing | Queue p95 ms | Avg payload bytes | 2xx MB/sec |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.queries.map(
      (query) =>
        `| \`${query.pattern}\` | ${format(query.target_per_second)} | ${format(query.achieved_per_second)} | ${format(query.p50_latency_ms)} / ${format(query.p95_latency_ms)} / ${format(query.p99_latency_ms)} | ${format(query.redis_p50_latency_ms)} / ${format(query.redis_p95_latency_ms)} / ${format(query.redis_p99_latency_ms)} | ${format(query.redis_timing_samples)} / ${format(query.redis_timing_missing_samples)} | ${format(query.socket_queue_p95_ms)} | ${format(query.average_api_payload_bytes)} | ${format(query.successful_response_megabytes_per_second)} |`
    ),
    `| **Total (${summary.query_patterns})** | **${format(summary.target_per_second)}** | **${format(summary.achieved_per_second)}** |  |  | **${format(summary.queries.reduce((total, query) => total + query.redis_timing_samples, 0))} / ${format(summary.queries.reduce((total, query) => total + query.redis_timing_missing_samples, 0))}** |  |  | **${format(summary.queries.reduce((total, query) => total + query.successful_response_megabytes_per_second, 0))}** |`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function patternIndex(pattern: string): number {
  const index = PATTERN_ORDER.indexOf(pattern);
  return index < 0 ? PATTERN_ORDER.length : index;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
