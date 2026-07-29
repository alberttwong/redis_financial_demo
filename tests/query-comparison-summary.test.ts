import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PATTERNS = [
  ["securityByNo", "security-by-no", 20],
  ["securityByNoDirect", "security-by-no-direct", 2],
  ["transactionsBySecurity", "transactions-by-security", 100],
  [
    "transactionsBySecurityMaterialized",
    "transactions-by-security-materialized",
    5
  ],
  [
    "transactionsByAccountSecurity",
    "transactions-by-account-security",
    40
  ],
  [
    "transactionsByAccountSecurityMaterialized",
    "transactions-by-account-security-materialized",
    4
  ]
] as const;

test("query comparison summary pairs baseline and optimized results", async () => {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "lpl-query-comparison-")
  );
  try {
    await Promise.all(
      PATTERNS.map(([pattern, slug, redisP95]) =>
        writeFile(
          path.join(outputDirectory, `query-${slug}.json`),
          `${JSON.stringify(queryFixture(pattern, redisP95))}\n`
        )
      )
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/summarize-query-comparison.ts",
        outputDirectory
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8"
      }
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const summary = JSON.parse(
      await readFile(
        path.join(outputDirectory, "query-comparison-summary.json"),
        "utf8"
      )
    ) as {
      comparisons: Array<{
        baseline_pattern: string;
        optimized_pattern: string;
        optimized_change_percent: { redis_p95_ms: number };
      }>;
    };
    assert.equal(summary.comparisons.length, 3);
    assert.deepEqual(
      summary.comparisons.map((comparison) => [
        comparison.baseline_pattern,
        comparison.optimized_pattern
      ]),
      [
        ["securityByNo", "securityByNoDirect"],
        [
          "transactionsBySecurity",
          "transactionsBySecurityMaterialized"
        ],
        [
          "transactionsByAccountSecurity",
          "transactionsByAccountSecurityMaterialized"
        ]
      ]
    );
    assert.equal(
      summary.comparisons[0].optimized_change_percent.redis_p95_ms,
      -90
    );

    const markdown = await readFile(
      path.join(outputDirectory, "query-comparison-summary.md"),
      "utf8"
    );
    assert.match(markdown, /securityByNoDirect/);
    assert.match(markdown, /-90%/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

function queryFixture(pattern: string, redisP95: number) {
  return {
    pattern,
    target_rps: 100,
    achieved_rps: 99,
    dropped_requests: 0,
    http_errors: 0,
    request_errors: 0,
    latency_ms: { p50: redisP95, p95: redisP95 + 2, p99: redisP95 + 4 },
    queue_latency_ms: { p50: 0, p95: 1, p99: 1 },
    redis_latency_ms: {
      p50: redisP95 / 2,
      p95: redisP95,
      p99: redisP95 + 1
    },
    average_api_payload_bytes: 100
  };
}
