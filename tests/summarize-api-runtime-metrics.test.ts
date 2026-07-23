import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("API runtime summary derives per-worker interval CPU, event loop, sockets, and Redis connections", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "lpl-api-runtime-"));
  try {
    const samples = [
      runtimeSample("2026-07-23T00:00:00.000Z", 100, 10, 90, 10, 0),
      runtimeSample("2026-07-23T00:00:05.000Z", 1_100, 1_010, 4_090, 20, 32),
      runtimeSample("2026-07-23T00:00:10.000Z", 2_600, 2_510, 7_590, 30, 32)
    ];
    await writeFile(
      path.join(outputDirectory, "api-runtime-light-01.ndjson"),
      `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`
    );

    runScript(outputDirectory);
    const summary = JSON.parse(
      await readFile(path.join(outputDirectory, "api-runtime-summary.json"), "utf8")
    ) as {
      worker_count: number;
      workers: Array<{
        process_cpu_utilization_percent: {
          average: number;
          p95: number;
          max: number;
        };
        event_loop_utilization_percent: {
          average: number;
          p95: number;
          max: number;
        };
        active_socket_file_descriptors: {
          average: number;
          p95: number;
          max: number;
        };
        redis_connections: {
          ready_final: number;
          ready_max: number;
        };
      }>;
    };
    assert.equal(summary.worker_count, 1);
    const worker = summary.workers[0];
    assert.deepEqual(worker.process_cpu_utilization_percent, {
      average: 25,
      p95: 30,
      max: 30
    });
    assert.deepEqual(worker.event_loop_utilization_percent, {
      average: 25,
      p95: 30,
      max: 30
    });
    assert.deepEqual(worker.active_socket_file_descriptors, {
      average: 20,
      p95: 30,
      max: 30
    });
    assert.deepEqual(worker.redis_connections, {
      configured: 32,
      ready_final: 32,
      ready_max: 32,
      open_final: 32,
      open_max: 32,
      errors_final: 0
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

function runtimeSample(
  capturedAt: string,
  cpuTotalMs: number,
  eventLoopActiveMs: number,
  eventLoopIdleMs: number,
  sockets: number,
  redisReady: number
) {
  return {
    captured_at: capturedAt,
    status_code: 200,
    health: {
      worker: {
        hostname: "api-light-01",
        pid: 1234,
        workload_class: "light",
        redis_connections: {
          configured_pool_size: 32,
          initialized_clients: redisReady,
          connecting_clients: 0,
          open_clients: redisReady,
          ready_clients: redisReady,
          cluster_clients: 0,
          error_count: 0
        }
      },
      runtime: {
        cpu: { total_ms: cpuTotalMs },
        event_loop_active_ms: eventLoopActiveMs,
        event_loop_idle_ms: eventLoopIdleMs,
        event_loop_delay_ms: { p95: 5, p99: 8 },
        active_sockets: {
          file_descriptors: sockets,
          resource_handles: sockets
        }
      }
    }
  };
}

function runScript(outputDirectory: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/summarize-api-runtime-metrics.ts",
      outputDirectory
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}
