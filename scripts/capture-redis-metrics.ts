import { mkdir, writeFile } from "node:fs/promises";
import { createClient } from "redis";
import { getRedisConfig } from "../src/lib/config";

const METRIC_FIELDS = [
  "used_memory",
  "maxmemory",
  "connected_clients",
  "blocked_clients",
  "rejected_connections",
  "instantaneous_ops_per_sec",
  "instantaneous_input_kbps",
  "instantaneous_output_kbps",
  "total_commands_processed",
  "keyspace_hits",
  "keyspace_misses"
] as const;

async function main() {
  const label = sanitizeLabel(process.argv[2] ?? "snapshot");
  const config = getRedisConfig();
  const client = createClient({
    url: config.url,
    username: config.username,
    password: config.password,
    socket: {
      tls: config.tls,
      connectTimeout: 10_000
    }
  });
  client.on("error", (error) => console.error("Redis metrics client error", error));

  await client.connect();
  const rawInfo = await client.sendCommand(["INFO", "ALL"]);
  await client.quit();
  if (typeof rawInfo !== "string") throw new Error("Redis INFO returned an unexpected response");

  const fields = parseInfo(rawInfo);
  const metrics = Object.fromEntries(
    METRIC_FIELDS.map((name) => [name, numericValue(fields[name])])
  );
  const hits = metrics.keyspace_hits;
  const misses = metrics.keyspace_misses;
  const output = {
    label,
    captured_at: new Date().toISOString(),
    ...metrics,
    keyspace_hit_ratio: hits + misses === 0 ? 0 : round(hits / (hits + misses))
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/redis-metrics-${label}.json`;
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputPath}`);
}

function parseInfo(rawInfo: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of rawInfo.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return fields;
}

function numericValue(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "snapshot";
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
