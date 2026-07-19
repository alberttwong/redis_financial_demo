import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type QueryResult = {
  pattern: string;
  target_rps: number;
  achieved_rps: number;
  dropped_requests: number;
  http_errors: number;
  request_errors: number;
  average_successful_response_bytes?: number;
  average_api_payload_bytes?: number;
  successful_response_megabytes_per_second?: number;
  socket_queue_ms?: {
    p95: number;
  };
  latency_ms: {
    p50: number;
    p95: number;
    p99: number;
    p99_9: number;
  };
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
  const byPattern = new Map<string, QueryResult>();
  for (const result of results) {
    if (byPattern.has(result.pattern)) {
      throw new Error(`Duplicate concurrent query result for ${result.pattern}.`);
    }
    byPattern.set(result.pattern, result);
  }

  const queries = [...byPattern.values()]
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
    average_api_payload_bytes: number;
    successful_response_megabytes_per_second: number;
    socket_queue_p95_ms: number;
  }>;
}): string {
  const lines = [
    "# Concurrent Query Results",
    "",
    "| Query pattern | Target/sec | Achieved/sec | p50 latency (ms) | p95 latency (ms) | p99 latency (ms) | Queue p95 (ms) | Avg payload bytes | 2xx MB/sec |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.queries.map(
      (query) =>
        `| \`${query.pattern}\` | ${format(query.target_per_second)} | ${format(query.achieved_per_second)} | ${format(query.p50_latency_ms)} | ${format(query.p95_latency_ms)} | ${format(query.p99_latency_ms)} | ${format(query.socket_queue_p95_ms)} | ${format(query.average_api_payload_bytes)} | ${format(query.successful_response_megabytes_per_second)} |`
    ),
    `| **Total (${summary.query_patterns})** | **${format(summary.target_per_second)}** | **${format(summary.achieved_per_second)}** |  |  |  |  |  | **${format(summary.queries.reduce((total, query) => total + query.successful_response_megabytes_per_second, 0))}** |`,
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
