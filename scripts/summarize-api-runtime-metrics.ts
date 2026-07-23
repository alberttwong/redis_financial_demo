import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type RedisConnections = {
  configured_pool_size?: number;
  initialized_clients?: number;
  connecting_clients?: number;
  open_clients?: number;
  ready_clients?: number;
  cluster_clients?: number;
  error_count?: number;
};

type HealthSample = {
  captured_at: string;
  status_code?: number;
  error?: string;
  health?: {
    worker?: {
      hostname?: string;
      pid?: number;
      workload_class?: string;
      redis_connections?: RedisConnections;
    };
    runtime?: {
      cpu?: {
        total_ms?: number;
      };
      event_loop_active_ms?: number;
      event_loop_idle_ms?: number;
      event_loop_delay_ms?: {
        p95?: number;
        p99?: number;
      };
      active_sockets?: {
        file_descriptors?: number;
        resource_handles?: number;
      };
    };
  };
};

type Distribution = {
  average: number;
  p95: number;
  max: number;
};

async function main() {
  const rootDirectory = process.argv[2];
  if (!rootDirectory) {
    throw new Error(
      "Usage: summarize-api-runtime-metrics.ts <aws-load-runner-output-directory>"
    );
  }

  const names = (await readdir(rootDirectory))
    .filter((name) => /^api-runtime-.+\.ndjson$/.test(name))
    .sort();
  const workers = await Promise.all(
    names.map(async (name) =>
      summarizeWorker(name, await readSamples(path.join(rootDirectory, name)))
    )
  );
  const summary = {
    experiment: "api-runtime-metrics",
    generated_at: new Date().toISOString(),
    worker_count: workers.length,
    workers
  };
  const jsonPath = path.join(rootDirectory, "api-runtime-summary.json");
  const markdownPath = path.join(rootDirectory, "api-runtime-summary.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`),
    writeFile(markdownPath, renderMarkdown(summary))
  ]);
  process.stdout.write(renderMarkdown(summary));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

async function readSamples(filePath: string): Promise<HealthSample[]> {
  return (await readFile(filePath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HealthSample];
      } catch {
        return [];
      }
    });
}

function summarizeWorker(fileName: string, samples: HealthSample[]) {
  const successful = samples.filter(
    (sample) => sample.status_code === 200 && sample.health?.runtime
  );
  const cpuUtilizationPercent: number[] = [];
  const eventLoopUtilizationPercent: number[] = [];

  for (let index = 1; index < successful.length; index += 1) {
    const previous = successful[index - 1];
    const current = successful[index];
    if (previous.health?.worker?.pid !== current.health?.worker?.pid) continue;
    const elapsedMs =
      Date.parse(current.captured_at) - Date.parse(previous.captured_at);
    const cpuDelta =
      number(current.health?.runtime?.cpu?.total_ms) -
      number(previous.health?.runtime?.cpu?.total_ms);
    if (elapsedMs > 0 && cpuDelta >= 0) {
      cpuUtilizationPercent.push((cpuDelta / elapsedMs) * 100);
    }

    const activeDelta =
      number(current.health?.runtime?.event_loop_active_ms) -
      number(previous.health?.runtime?.event_loop_active_ms);
    const idleDelta =
      number(current.health?.runtime?.event_loop_idle_ms) -
      number(previous.health?.runtime?.event_loop_idle_ms);
    if (activeDelta >= 0 && idleDelta >= 0 && activeDelta + idleDelta > 0) {
      eventLoopUtilizationPercent.push(
        (activeDelta / (activeDelta + idleDelta)) * 100
      );
    }
  }

  const last = successful.at(-1);
  const socketFileDescriptors = successful.map((sample) =>
    number(sample.health?.runtime?.active_sockets?.file_descriptors)
  );
  const socketResourceHandles = successful.map((sample) =>
    number(sample.health?.runtime?.active_sockets?.resource_handles)
  );
  const readyRedisConnections = successful.map((sample) =>
    number(sample.health?.worker?.redis_connections?.ready_clients)
  );
  const openRedisConnections = successful.map((sample) =>
    number(sample.health?.worker?.redis_connections?.open_clients)
  );
  const redisErrors = successful.map((sample) =>
    number(sample.health?.worker?.redis_connections?.error_count)
  );
  const eventLoopDelayP95 = successful.map((sample) =>
    number(sample.health?.runtime?.event_loop_delay_ms?.p95)
  );
  const eventLoopDelayP99 = successful.map((sample) =>
    number(sample.health?.runtime?.event_loop_delay_ms?.p99)
  );

  return {
    worker: fileName.replace(/^api-runtime-/, "").replace(/\.ndjson$/, ""),
    hostname: last?.health?.worker?.hostname ?? null,
    pid: last?.health?.worker?.pid ?? null,
    workload_class: last?.health?.worker?.workload_class ?? null,
    captured_samples: samples.length,
    successful_samples: successful.length,
    failed_samples: samples.length - successful.length,
    started_at: successful.at(0)?.captured_at ?? null,
    ended_at: last?.captured_at ?? null,
    process_cpu_utilization_percent: distribution(cpuUtilizationPercent),
    event_loop_utilization_percent: distribution(eventLoopUtilizationPercent),
    event_loop_delay_ms: {
      max_p95: maximum(eventLoopDelayP95),
      max_p99: maximum(eventLoopDelayP99)
    },
    active_socket_file_descriptors: distribution(socketFileDescriptors),
    active_socket_resource_handles: distribution(socketResourceHandles),
    redis_connections: {
      configured:
        last?.health?.worker?.redis_connections?.configured_pool_size ?? 0,
      ready_final: readyRedisConnections.at(-1) ?? 0,
      ready_max: maximum(readyRedisConnections),
      open_final: openRedisConnections.at(-1) ?? 0,
      open_max: maximum(openRedisConnections),
      errors_final: redisErrors.at(-1) ?? 0
    }
  };
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { average: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    average: round(values.reduce((total, value) => total + value, 0) / values.length),
    p95: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]),
    max: round(sorted.at(-1) ?? 0)
  };
}

function maximum(values: number[]): number {
  return round(values.length === 0 ? 0 : Math.max(...values));
}

function number(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderMarkdown(summary: {
  worker_count: number;
  workers: Array<ReturnType<typeof summarizeWorker>>;
}): string {
  const lines = [
    "# API Runtime Metrics",
    "",
    "CPU and event-loop utilization are interval values derived from cumulative counters returned by each worker.",
    "Process CPU is measured in one-core equivalents and can exceed 100% when worker threads use multiple cores.",
    "",
    "| Worker | Samples | CPU avg/p95/max % | Event loop avg/p95/max % | Event-loop delay p95/p99 ms | Socket FDs avg/p95/max | Redis ready final/max | Redis errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...summary.workers.map(
      (worker) =>
        `| \`${worker.worker}\` | ${worker.successful_samples}/${worker.captured_samples} | ${triple(worker.process_cpu_utilization_percent)} | ${triple(worker.event_loop_utilization_percent)} | ${format(worker.event_loop_delay_ms.max_p95)} / ${format(worker.event_loop_delay_ms.max_p99)} | ${triple(worker.active_socket_file_descriptors)} | ${format(worker.redis_connections.ready_final)} / ${format(worker.redis_connections.ready_max)} | ${format(worker.redis_connections.errors_final)} |`
    ),
    `| **Total (${summary.worker_count})** |  |  |  |  |  |  |  |`,
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function triple(value: Distribution): string {
  return `${format(value.average)} / ${format(value.p95)} / ${format(value.max)}`;
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
