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
  return {
    started_at: new Date(state.startedAt).toISOString(),
    uptime_seconds: Math.round(process.uptime() * 100) / 100,
    event_loop_utilization: round(utilization.utilization),
    event_loop_active_ms: round(utilization.active),
    event_loop_idle_ms: round(utilization.idle),
    event_loop_delay_ms: {
      mean: nanosecondsToMilliseconds(state.eventLoopDelay.mean),
      max: nanosecondsToMilliseconds(state.eventLoopDelay.max),
      p50: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(50)),
      p95: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(95)),
      p99: nanosecondsToMilliseconds(state.eventLoopDelay.percentile(99))
    }
  };
}

function nanosecondsToMilliseconds(value: number): number {
  return round(Number.isFinite(value) ? value / 1_000_000 : 0);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
