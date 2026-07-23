import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const url = process.argv[2] ?? "http://127.0.0.1:3000/api/health";
const outputPath = process.argv[3];
const intervalMs = readPositiveInteger(process.argv[4] ?? "5000", "poll interval");
const requestTimeoutMs = Math.min(intervalMs, 4_000);
let stopping = false;

if (!outputPath) {
  throw new Error(
    "Usage: capture-api-runtime.ts <health-url> <output-ndjson-path> [poll-interval-ms]"
  );
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "");

  while (!stopping) {
    const sampleStartedAt = performance.now();
    const capturedAt = new Date().toISOString();
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const body = await response.text();
      let health: unknown;
      try {
        health = JSON.parse(body);
      } catch {
        health = { unparseable_body: body.slice(0, 1_000) };
      }
      await appendSample({
        captured_at: capturedAt,
        request_duration_ms: round(performance.now() - sampleStartedAt),
        status_code: response.status,
        health
      });
    } catch (error) {
      await appendSample({
        captured_at: capturedAt,
        request_duration_ms: round(performance.now() - sampleStartedAt),
        error: error instanceof Error ? error.message : String(error)
      });
    }

    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function appendSample(sample: object): Promise<void> {
  await appendFile(outputPath, `${JSON.stringify(sample)}\n`);
}

function readPositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; received ${value}`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
