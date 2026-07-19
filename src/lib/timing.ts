import { performance } from "node:perf_hooks";

export async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return {
    value,
    ms: roundMs(performance.now() - start)
  };
}

export function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
