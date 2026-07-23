import { readdirSync, readlinkSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

type RuntimeMetricState = {
  eventLoopDelay: ReturnType<typeof monitorEventLoopDelay>;
  eventLoopBaseline: ReturnType<typeof performance.eventLoopUtilization>;
  startedAt: number;
};

const globalRuntimeMetrics = globalThis as typeof globalThis & {
  __lplRuntimeMetrics?: RuntimeMetricState;
};

function metricState(): RuntimeMetricState {
  if (!globalRuntimeMetrics.__lplRuntimeMetrics) {
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    globalRuntimeMetrics.__lplRuntimeMetrics = {
      eventLoopDelay,
      eventLoopBaseline: performance.eventLoopUtilization(),
      startedAt: Date.now()
    };
  }
  return globalRuntimeMetrics.__lplRuntimeMetrics;
}

export function readRuntimeMetrics() {
  const state = metricState();
  const utilization = performance.eventLoopUtilization(state.eventLoopBaseline);
  const cpu = process.cpuUsage();
  const cpuUserMs = microsecondsToMilliseconds(cpu.user);
  const cpuSystemMs = microsecondsToMilliseconds(cpu.system);
  const cpuTotalMs = round(cpuUserMs + cpuSystemMs);
  const uptimeMs = process.uptime() * 1_000;
  const activeResources = countValues(process.getActiveResourcesInfo());
  return {
    started_at: new Date(state.startedAt).toISOString(),
    uptime_seconds: Math.round(process.uptime() * 100) / 100,
    cpu: {
      user_ms: cpuUserMs,
      system_ms: cpuSystemMs,
      total_ms: cpuTotalMs,
      average_utilization: round(uptimeMs === 0 ? 0 : cpuTotalMs / uptimeMs)
    },
    event_loop_utilization: round(utilization.utilization),
    event_loop_active_ms: round(utilization.active),
    event_loop_idle_ms: round(utilization.idle),
    event_loop_delay_ms: {
      mean: nanosecondsToMilliseconds(state.eventLoopDelay.mean),
      max: nanosecondsToMilliseconds(state.eventLoopDelay.max),
      p50: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(50)),
      p95: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(95)),
      p99: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(99))
    },
    active_sockets: {
      file_descriptors: countSocketFileDescriptors(),
      resource_handles: Object.entries(activeResources)
        .filter(([name]) => name.toLowerCase().includes("tcp"))
        .reduce((total, [, count]) => total + count, 0)
    },
    active_resources: activeResources
  };
}

function microsecondsToMilliseconds(value: number): number {
  return round(value / 1_000);
}

function nanosecondsToMilliseconds(value: number): number {
  return round(Number.isFinite(value) ? value / 1_000_000 : 0);
}

function countSocketFileDescriptors(): number {
  try {
    return readdirSync("/proc/self/fd").reduce((count, entry) => {
      try {
        return count + (readlinkSync(`/proc/self/fd/${entry}`).startsWith("socket:[") ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
  } catch {
    return 0;
  }
}

function countValues(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())]
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
