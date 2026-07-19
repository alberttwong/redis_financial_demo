import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PATTERNS = [
  "positionsByAccount",
  "transactionsByAccount",
  "transactionsBySecurity",
  "accountPortfolioJoin",
  "accountActivityJoin",
  "accountSnapshot"
] as const;

const ALLOWED_PATTERNS = new Set(DEFAULT_PATTERNS);

type HeavyPattern = (typeof DEFAULT_PATTERNS)[number];
type StaircaseSummary = {
  pattern: HeavyPattern;
  target_count: number;
  validated_aggregate_rps: number;
  validated_rps_per_target: number;
  safe_rps_per_target: number;
  recommended_alb_request_count_per_target_per_minute: number;
};

async function main() {
  const patterns = parsePatterns(process.env.QUERY_STAIRCASE_SUITE_PATTERNS);
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
    experiment: "isolated-heavy-query-staircase-suite",
    base_url: process.env.QUERY_BASE_URL ?? "http://127.0.0.1:3000",
    patterns: summaries
  };
  await Promise.all([
    writeFile(path.join(rootDirectory, "heavy-staircase-summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`),
    writeFile(path.join(rootDirectory, "heavy-staircase-summary.md"), renderMarkdown(summaries))
  ]);
  console.log(`\nWrote heavy staircase suite to ${rootDirectory}`);
}

function runStaircase(pattern: HeavyPattern, outputDirectory: string, targetCount: number): Promise<number> {
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

function parsePatterns(value: string | undefined): HeavyPattern[] {
  if (!value?.trim()) return [...DEFAULT_PATTERNS];
  const patterns = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (patterns.length === 0) {
    throw new Error("QUERY_STAIRCASE_SUITE_PATTERNS must contain at least one pattern");
  }
  const invalid = patterns.filter((pattern) => !ALLOWED_PATTERNS.has(pattern as HeavyPattern));
  if (invalid.length > 0) {
    throw new Error(`QUERY_STAIRCASE_SUITE_PATTERNS contains unsupported patterns: ${invalid.join(", ")}`);
  }
  return patterns as HeavyPattern[];
}

function parseTargetCounts(value: string | undefined): Partial<Record<HeavyPattern, number>> {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QUERY_STAIRCASE_TARGET_COUNTS_JSON must be a JSON object");
  }
  const result: Partial<Record<HeavyPattern, number>> = {};
  for (const [pattern, count] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALLOWED_PATTERNS.has(pattern as HeavyPattern)) {
      throw new Error(`QUERY_STAIRCASE_TARGET_COUNTS_JSON contains unsupported pattern ${pattern}`);
    }
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Target count for ${pattern} must be a positive integer`);
    }
    result[pattern as HeavyPattern] = count;
  }
  return result;
}

function renderMarkdown(summaries: StaircaseSummary[]): string {
  const lines = [
    "# Heavy Query Staircase Suite",
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
