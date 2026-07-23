import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ALL_PATTERNS = [
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
] as const;

const DEFAULT_PATTERNS = [
  "positionsByAccount",
  "transactionsByAccount",
  "transactionsBySecurity",
  "accountPortfolioJoin",
  "accountActivityJoin",
  "accountSnapshot"
] as const satisfies readonly QueryPattern[];

const EXPECTED_PAYLOAD_BYTES: Record<QueryPattern, number> = {
  accountById: 196.18,
  securityById: 8192,
  securityByNo: 332.37,
  positionByComposite: 8192,
  positionsByAccount: 119169.79,
  transactionById: 8192,
  transactionsByAccount: 33848,
  transactionsBySecurity: 33844.66,
  transactionsByAccountSecurity: 3126,
  accountPortfolioJoin: 294033.19,
  accountActivityJoin: 136833.38,
  accountSnapshot: 430879.7
};

const ALLOWED_PATTERNS = new Set<string>(ALL_PATTERNS);

type QueryPattern = (typeof ALL_PATTERNS)[number];
type StaircaseSummary = {
  pattern: QueryPattern;
  target_count: number;
  validated_aggregate_rps: number;
  validated_rps_per_target: number;
  safe_rps_per_target: number;
  recommended_alb_request_count_per_target_per_minute: number;
};

async function main() {
  const suiteName = process.env.QUERY_STAIRCASE_SUITE_NAME === "all" ? "all" : "heavy";
  const patterns = parsePatterns(process.env.QUERY_STAIRCASE_SUITE_PATTERNS, suiteName);
  const targetCounts = parseTargetCounts(process.env.QUERY_STAIRCASE_TARGET_COUNTS_JSON);
  const rootDirectory = path.resolve(
    process.env.LOAD_TEST_OUTPUT_DIR ??
      path.join("memtier-output", `heavy-staircases-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  );
  await mkdir(rootDirectory, { recursive: true });

  const summaries: StaircaseSummary[] = [];
  for (const pattern of patterns) {
    const patternDirectory = path.join(rootDirectory, pattern);
    await mkdir(patternDirectory, { recursive: true });
    console.log(`\nStarting isolated staircase for ${pattern}...`);
    const exitCode = await runStaircase(pattern, patternDirectory, targetCounts[pattern] ?? 1);
    if (exitCode !== 0) throw new Error(`${pattern} staircase exited with code ${exitCode}`);
    summaries.push(
      JSON.parse(await readFile(path.join(patternDirectory, "query-staircase-summary.json"), "utf8")) as StaircaseSummary
    );
  }

  const aggregate = {
    experiment: `isolated-${suiteName}-query-staircase-suite`,
    base_url: process.env.QUERY_BASE_URL ?? "http://127.0.0.1:3000",
    patterns: summaries
  };
  const summaryBaseName = suiteName === "all" ? "query-staircase-suite-summary" : "heavy-staircase-summary";
  await Promise.all([
    writeFile(path.join(rootDirectory, `${summaryBaseName}.json`), `${JSON.stringify(aggregate, null, 2)}\n`),
    writeFile(path.join(rootDirectory, `${summaryBaseName}.md`), renderMarkdown(summaries, suiteName))
  ]);
  console.log(`\nWrote ${suiteName} staircase suite to ${rootDirectory}`);
}

function runStaircase(pattern: QueryPattern, outputDirectory: string, targetCount: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/bench-query-staircase.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QUERY_STAIRCASE_PATTERN: pattern,
          QUERY_STAIRCASE_TARGET_COUNT: String(targetCount),
          QUERY_STAIRCASE_EXPECTED_PAYLOAD_BYTES: String(EXPECTED_PAYLOAD_BYTES[pattern]),
          LOAD_TEST_OUTPUT_DIR: outputDirectory
        },
        stdio: "inherit"
      }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${pattern} staircase terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function parsePatterns(value: string | undefined, suiteName: "all" | "heavy"): QueryPattern[] {
  if (!value?.trim()) return suiteName === "all" ? [...ALL_PATTERNS] : [...DEFAULT_PATTERNS];
  const patterns = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (patterns.length === 0) {
    throw new Error("QUERY_STAIRCASE_SUITE_PATTERNS must contain at least one pattern");
  }
  const invalid = patterns.filter((pattern) => !ALLOWED_PATTERNS.has(pattern));
  if (invalid.length > 0) {
    throw new Error(`QUERY_STAIRCASE_SUITE_PATTERNS contains unsupported patterns: ${invalid.join(", ")}`);
  }
  return patterns as QueryPattern[];
}

function parseTargetCounts(value: string | undefined): Partial<Record<QueryPattern, number>> {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QUERY_STAIRCASE_TARGET_COUNTS_JSON must be a JSON object");
  }
  const result: Partial<Record<QueryPattern, number>> = {};
  for (const [pattern, count] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALLOWED_PATTERNS.has(pattern)) {
      throw new Error(`QUERY_STAIRCASE_TARGET_COUNTS_JSON contains unsupported pattern ${pattern}`);
    }
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Target count for ${pattern} must be a positive integer`);
    }
    result[pattern as QueryPattern] = count;
  }
  return result;
}

function renderMarkdown(summaries: StaircaseSummary[], suiteName: "all" | "heavy"): string {
  const lines = [
    suiteName === "all" ? "# Complete Query Staircase Suite" : "# Heavy Query Staircase Suite",
    "",
    "| Pattern | Targets | Validated aggregate/sec | Validated/target/sec | Safe/target/sec | Suggested ALB target/min |",
    "|---|---:|---:|---:|---:|---:|",
    ...summaries.map(
      (summary) =>
        `| \`${summary.pattern}\` | ${format(summary.target_count)} | ${format(summary.validated_aggregate_rps)} | ${format(summary.validated_rps_per_target)} | ${format(summary.safe_rps_per_target)} | ${format(summary.recommended_alb_request_count_per_target_per_minute)} |`
    ),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
