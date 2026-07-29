import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("concurrent summary merges Redis timing histograms across generator shards", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "lpl-concurrent-summary-"));
  try {
    const first = path.join(outputDirectory, "host-01");
    const second = path.join(outputDirectory, "host-02");
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all([
      writeFile(
        path.join(first, "query-account-by-id.json"),
        `${JSON.stringify(queryFixture([[1, 1], [3, 1]], 1))}\n`
      ),
      writeFile(
        path.join(second, "query-account-by-id.json"),
        `${JSON.stringify(queryFixture([[2, 2]], 0))}\n`
      )
    ]);

    runScript("scripts/summarize-concurrent-results.ts", outputDirectory);
    const summary = JSON.parse(
      await readFile(
        path.join(outputDirectory, "concurrent-query-summary.json"),
        "utf8"
      )
    ) as {
      queries: Array<Record<string, number>>;
    };
    const query = summary.queries[0];
    assert.equal(query.target_per_second, 20);
    assert.equal(query.achieved_per_second, 18);
    assert.equal(query.queue_timing_samples, 4);
    assert.equal(query.queue_timing_missing_samples, 0);
    assert.equal(query.queue_p50_latency_ms, 1);
    assert.equal(query.queue_p95_latency_ms, 2);
    assert.equal(query.queue_p99_latency_ms, 2);
    assert.equal(query.redis_timing_samples, 4);
    assert.equal(query.redis_timing_missing_samples, 1);
    assert.equal(query.redis_p50_latency_ms, 2);
    assert.equal(query.redis_p95_latency_ms, 3);
    assert.equal(query.redis_p99_latency_ms, 3);

    const markdown = await readFile(
      path.join(outputDirectory, "concurrent-query-summary.md"),
      "utf8"
    );
    assert.match(markdown, /API queue p50\/p95\/p99 ms/);
    assert.match(markdown, /Redis p50\/p95\/p99 ms/);
    assert.match(markdown, /4 \/ 1/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

function queryFixture(
  redisHistogram: Array<[number, number]>,
  missingSamples: number
) {
  return {
    pattern: "accountById",
    target_rps: 10,
    achieved_rps: 9,
    successful_requests: 2,
    dropped_requests: 0,
    http_errors: 0,
    request_errors: 0,
    average_successful_response_bytes: 100,
    average_api_payload_bytes: 80,
    successful_response_megabytes_per_second: 0.001,
    socket_queue_ms: { p95: 1 },
    latency_histogram_ms: [[5, 2]],
    queue_latency_ms: {
      samples: 2,
      p50: redisHistogram[0][0] - 1,
      p95: redisHistogram.at(-1)?.[0] ?? 0,
      p99: redisHistogram.at(-1)?.[0] ?? 0,
      p99_9: redisHistogram.at(-1)?.[0] ?? 0
    },
    queue_timing_missing_samples: 0,
    queue_latency_histogram_ms: redisHistogram.map(
      ([latency, count]) => [Math.max(0, latency - 1), count] as [number, number]
    ),
    socket_queue_histogram_ms: [[1, 2]],
    latency_ms: { p50: 5, p95: 5, p99: 5, p99_9: 5 },
    redis_latency_ms: {
      samples: 2,
      p50: redisHistogram[0][0],
      p95: redisHistogram.at(-1)?.[0] ?? 0,
      p99: redisHistogram.at(-1)?.[0] ?? 0,
      p99_9: redisHistogram.at(-1)?.[0] ?? 0
    },
    redis_timing_missing_samples: missingSamples,
    redis_latency_histogram_ms: redisHistogram
  };
}

function runScript(script: string, outputDirectory: string): void {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, outputDirectory],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
