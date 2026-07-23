import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const QUERY_SLUGS = {
  accountById: "account-by-id",
  securityById: "security-by-id",
  securityByNo: "security-by-no",
  positionByComposite: "position-by-composite",
  positionsByAccount: "positions-by-account",
  transactionById: "transaction-by-id",
  transactionsByAccount: "transactions-by-account",
  transactionsBySecurity: "transactions-by-security",
  transactionsByAccountSecurity: "transactions-by-account-security",
  accountPortfolioJoin: "account-portfolio-join",
  accountActivityJoin: "account-activity-join",
  accountSnapshot: "account-snapshot"
} as const;

type StaircasePattern = keyof typeof QUERY_SLUGS;
type QueryResult = {
  target_rps: number;
  achieved_rps: number;
  error_rate: number;
  dropped_requests: number;
  latency_ms: { p50: number; p95: number; p99: number };
  socket_queue_ms?: { p95: number };
  average_api_payload_bytes?: number;
  successful_response_megabytes_per_second?: number;
};
type StaircaseStep = {
  target_rps: number;
  achieved_rps: number;
  achievement_ratio: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  socket_queue_p95_ms: number;
  error_rate: number;
  dropped_requests: number;
  average_api_payload_bytes: number;
  successful_response_megabytes_per_second: number;
  passed: boolean;
  failure_reasons: string[];
  result_path: string;
};

async function main() {
  const pattern = process.env.QUERY_STAIRCASE_PATTERN ?? process.argv[2] ?? "accountById";
  if (!isStaircasePattern(pattern)) {
    throw new Error(`QUERY_STAIRCASE_PATTERN must be one of: ${Object.keys(QUERY_SLUGS).join(", ")}`);
  }

  const rates = parseRates(process.env.QUERY_STAIRCASE_RATES ?? "1000,2000,4000,8000");
  const p95SloMs = readPositiveNumber("QUERY_STAIRCASE_P95_SLO_MS", 250);
  const targetCount = readPositiveInteger("QUERY_STAIRCASE_TARGET_COUNT", 1);
  const maxErrorRate = readNonNegativeRatio("QUERY_STAIRCASE_MAX_ERROR_RATE", 0.001);
  const minAchievementRatio = readRatio("QUERY_STAIRCASE_MIN_ACHIEVEMENT_RATIO", 0.98);
  const headroomFactor = readPositiveNumber("QUERY_STAIRCASE_HEADROOM_FACTOR", 1.3);
  const expectedPayloadBytes = readNonNegativeNumber("QUERY_STAIRCASE_EXPECTED_PAYLOAD_BYTES", 0);
  const payloadTolerance = readNonNegativeRatio("QUERY_STAIRCASE_PAYLOAD_TOLERANCE", 0.05);
  if (headroomFactor < 1) {
    throw new Error("QUERY_STAIRCASE_HEADROOM_FACTOR must be at least one.");
  }
  const stopOnFailure = readBoolean("QUERY_STAIRCASE_STOP_ON_FAILURE", true);
  const slug = QUERY_SLUGS[pattern];
  const rootDirectory = path.resolve(
    process.env.LOAD_TEST_OUTPUT_DIR ??
      path.join("memtier-output", `staircase-${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
  );
  await mkdir(rootDirectory, { recursive: true });

  const steps: StaircaseStep[] = [];
  for (const rate of rates) {
    const stepDirectory = path.join(rootDirectory, `step-${rate}-rps`);
    await mkdir(stepDirectory, { recursive: true });
    console.log(`\n${pattern}: starting isolated ${rate} requests/sec staircase step`);
    const exitCode = await runQueryStep(pattern, rate, stepDirectory);
    const resultPath = path.join(stepDirectory, `query-${slug}.json`);
    let result: QueryResult;
    try {
      result = JSON.parse(await readFile(resultPath, "utf8")) as QueryResult;
    } catch (error) {
      throw new Error(
        `${pattern} ${rate} requests/sec did not produce ${resultPath} (generator exit ${exitCode}): ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const achievementRatio = result.target_rps === 0 ? 0 : result.achieved_rps / result.target_rps;
    const measuredPayloadBytes = result.average_api_payload_bytes ?? 0;
    const minimumPayloadBytes = expectedPayloadBytes * (1 - payloadTolerance);
    const maximumPayloadBytes = expectedPayloadBytes * (1 + payloadTolerance);
    const failureReasons = [
      ...(result.dropped_requests > 0 ? [`${result.dropped_requests} scheduler drops`] : []),
      ...(result.error_rate > maxErrorRate
        ? [`error rate ${format(result.error_rate)} exceeds ${format(maxErrorRate)}`]
        : []),
      ...(achievementRatio < minAchievementRatio
        ? [`achievement ratio ${format(achievementRatio)} is below ${format(minAchievementRatio)}`]
        : []),
      ...(result.latency_ms.p95 > p95SloMs
        ? [`p95 ${format(result.latency_ms.p95)}ms exceeds ${format(p95SloMs)}ms`]
        : []),
      ...(expectedPayloadBytes > 0 &&
      (measuredPayloadBytes < minimumPayloadBytes || measuredPayloadBytes > maximumPayloadBytes)
        ? [
            `payload ${format(measuredPayloadBytes)} bytes is outside ${format(minimumPayloadBytes)}-${format(maximumPayloadBytes)} bytes`
          ]
        : [])
    ];
    const step: StaircaseStep = {
      target_rps: result.target_rps,
      achieved_rps: result.achieved_rps,
      achievement_ratio: round(achievementRatio),
      p50_latency_ms: result.latency_ms.p50,
      p95_latency_ms: result.latency_ms.p95,
      p99_latency_ms: result.latency_ms.p99,
      socket_queue_p95_ms: result.socket_queue_ms?.p95 ?? 0,
      error_rate: result.error_rate,
      dropped_requests: result.dropped_requests,
      average_api_payload_bytes: measuredPayloadBytes,
      successful_response_megabytes_per_second:
        result.successful_response_megabytes_per_second ?? 0,
      passed: failureReasons.length === 0,
      failure_reasons: failureReasons,
      result_path: path.relative(rootDirectory, resultPath)
    };
    steps.push(step);
    console.log(
      `${pattern}: target=${format(step.target_rps)} achieved=${format(step.achieved_rps)} p95=${format(step.p95_latency_ms)}ms result=${step.passed ? "PASS" : "SLO LIMIT"}`
    );
    if (!step.passed && stopOnFailure) break;
  }

  const validatedAggregateRps = steps.filter((step) => step.passed).at(-1)?.achieved_rps ?? 0;
  const validatedRpsPerTarget = round(validatedAggregateRps / targetCount);
  const safeRpsPerTarget = round(validatedRpsPerTarget / headroomFactor);
  const summary = {
    experiment: "isolated-query-staircase",
    pattern,
    base_url: process.env.QUERY_BASE_URL ?? "http://127.0.0.1:3000",
    target_count: targetCount,
    thresholds: {
      p95_slo_ms: p95SloMs,
      max_error_rate: maxErrorRate,
      min_achievement_ratio: minAchievementRatio,
      capacity_headroom_factor: headroomFactor,
      expected_payload_bytes: expectedPayloadBytes,
      payload_tolerance: payloadTolerance
    },
    validated_aggregate_rps: validatedAggregateRps,
    validated_rps_per_target: validatedRpsPerTarget,
    safe_rps_per_target: safeRpsPerTarget,
    recommended_alb_request_count_per_target_per_minute: Math.floor(safeRpsPerTarget * 60),
    steps
  };
  const jsonPath = path.join(rootDirectory, "query-staircase-summary.json");
  const markdownPath = path.join(rootDirectory, "query-staircase-summary.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(summary))
  ]);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

async function runQueryStep(
  pattern: StaircasePattern,
  rate: number,
  outputDirectory: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file-if-exists=.env.local", "--import", "tsx", "scripts/load-query-pattern.ts", pattern],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOAD_TEST_OUTPUT_DIR: outputDirectory,
          QUERY_DEFAULT_TARGET_RPS: String(rate),
          QUERY_JOIN_TARGET_RPS: String(rate)
        },
        stdio: "inherit"
      }
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${pattern} ${rate} requests/sec terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function parseRates(value: string): number[] {
  const rates = [...new Set(value.split(",").map((entry) => Number(entry.trim())))];
  if (rates.length === 0 || rates.some((rate) => !Number.isSafeInteger(rate) || rate < 1)) {
    throw new Error("QUERY_STAIRCASE_RATES must be a comma-separated list of positive integers.");
  }
  return rates.sort((left, right) => left - right);
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function readNonNegativeRatio(name: string, fallback: number): number {
  const value = readNonNegativeNumber(name, fallback);
  if (value > 1) throw new Error(`${name} must be between zero and one.`);
  return value;
}

function readRatio(name: string, fallback: number): number {
  const value = readPositiveNumber(name, fallback);
  if (value > 1) throw new Error(`${name} must be greater than zero and at most one.`);
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be 0, 1, false, or true.`);
}

function isStaircasePattern(value: string): value is StaircasePattern {
  return value in QUERY_SLUGS;
}

function renderMarkdown(summary: {
  pattern: string;
  target_count: number;
  validated_aggregate_rps: number;
  validated_rps_per_target: number;
  safe_rps_per_target: number;
  recommended_alb_request_count_per_target_per_minute: number;
  steps: StaircaseStep[];
}): string {
  const lines = [
    `# ${summary.pattern} Isolated Staircase`,
    "",
    "| Target/sec | Achieved/sec | Ratio | p50 ms | p95 ms | p99 ms | Queue p95 ms | Error rate | Drops | Avg payload bytes | 2xx MB/sec | Result |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|",
    ...summary.steps.map(
      (step) =>
        `| ${format(step.target_rps)} | ${format(step.achieved_rps)} | ${format(step.achievement_ratio)} | ${format(step.p50_latency_ms)} | ${format(step.p95_latency_ms)} | ${format(step.p99_latency_ms)} | ${format(step.socket_queue_p95_ms)} | ${format(step.error_rate)} | ${format(step.dropped_requests)} | ${format(step.average_api_payload_bytes)} | ${format(step.successful_response_megabytes_per_second)} | ${step.passed ? "PASS" : `LIMIT: ${step.failure_reasons.join("; ")}`} |`
    ),
    "",
    `Target count: **${format(summary.target_count)}**.`,
    `Validated aggregate capacity: **${format(summary.validated_aggregate_rps)} requests/sec**.`,
    `Validated capacity: **${format(summary.validated_rps_per_target)} requests/sec per target**.`,
    `Capacity with headroom: **${format(summary.safe_rps_per_target)} requests/sec per target**.`,
    `Suggested ALB request-count target: **${format(summary.recommended_alb_request_count_per_target_per_minute)} requests/target/minute**.`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
