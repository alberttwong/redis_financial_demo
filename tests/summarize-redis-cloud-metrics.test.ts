import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Redis Cloud summary reports throughput, latency, memory, and hit-ratio distributions", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "lpl-redis-cloud-"));
  const inputPath = path.join(outputDirectory, "redis-cloud-metrics.ndjson");
  try {
    const samples = [
      metricSample("2026-07-23T00:00:00.000Z", 100, 0.001, 50, 10),
      metricSample("2026-07-23T00:00:15.000Z", 200, 0.002, 60, 20),
      metricSample("2026-07-23T00:00:30.000Z", 300, 0.003, 70, 30)
    ];
    await writeFile(
      inputPath,
      `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/summarize-redis-cloud-metrics.ts",
        inputPath,
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
        path.join(outputDirectory, "redis-cloud-metrics-summary.json"),
        "utf8"
      )
    ) as {
      successful_samples: number;
      metrics: Record<
        string,
        { samples: number; average: number; p95: number; max: number; latest: number }
      >;
      derived: Record<
        string,
        { samples: number; average: number; p95: number; max: number; latest: number }
      >;
    };

    assert.equal(summary.successful_samples, 3);
    assert.deepEqual(summary.metrics.bdb_instantaneous_ops_per_sec, {
      label: "Operations",
      unit: "ops/sec",
      samples: 3,
      average: 200,
      p95: 300,
      max: 300,
      latest: 300
    });
    assert.equal(summary.metrics.bdb_avg_latency.average, 2);
    assert.equal(summary.derived.memory_utilization_percent.average, 60);
    assert.equal(summary.derived.memory_utilization_percent.p95, 70);
    assert.equal(summary.derived.read_hit_ratio_percent.average, 90);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

function metricSample(
  capturedAt: string,
  operations: number,
  latencySeconds: number,
  usedMemory: number,
  connections: number
) {
  const series = (value: number) => [
    {
      labels: { bdb: "123" },
      value
    }
  ];
  return {
    captured_at: capturedAt,
    status: "ok",
    metrics: {
      bdb_instantaneous_ops_per_sec: series(operations),
      bdb_avg_latency: series(latencySeconds),
      bdb_used_memory: series(usedMemory),
      bdb_memory_limit: series(100),
      bdb_read_hits: series(90),
      bdb_read_misses: series(10),
      bdb_conns: series(connections)
    }
  };
}
