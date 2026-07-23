import { mkdir, writeFile } from "node:fs/promises";
import { createRedisConnection, isRedisCluster, redisClusterMasters } from "../src/lib/redis";

const METRIC_FIELDS = [
  "used_memory",
  "maxmemory",
  "connected_clients",
  "blocked_clients",
  "rejected_connections",
  "instantaneous_ops_per_sec",
  "instantaneous_input_kbps",
  "instantaneous_output_kbps",
  "total_net_input_bytes",
  "total_net_output_bytes",
  "total_commands_processed",
  "keyspace_hits",
  "keyspace_misses",
  "used_cpu_sys",
  "used_cpu_user"
] as const;

async function main() {
  const label = sanitizeLabel(process.argv[2] ?? "snapshot");
  const client = await createRedisConnection();
  const nodes = isRedisCluster(client)
    ? await Promise.all(
        redisClusterMasters(client).map(async (master) => {
          const node = await client.nodeClient(master);
          const rawInfo = await node.sendCommand(["INFO", "ALL"]);
          return metricNode(master.id, master.address, rawInfo);
        })
      )
    : [metricNode("standalone", "configured-endpoint", await client.sendCommand(["INFO", "ALL"]))];
  await client.quit();
  const infoScope = usesDatabaseGlobalInfo(nodes) ? "database-global" : "per-primary";
  const aggregation = infoScope === "database-global" ? "representative" : "sum";
  const metrics = Object.fromEntries(
    METRIC_FIELDS.map((name) => [name, aggregation === "representative" ? nodes[0][name] : sum(nodes.map((node) => node[name]))])
  );
  const hits = metrics.keyspace_hits;
  const misses = metrics.keyspace_misses;
  const output = {
    label,
    captured_at: new Date().toISOString(),
    topology: nodes.length > 1 ? "cluster" : "standalone",
    primary_count: nodes.length,
    info_scope: infoScope,
    aggregation,
    ...metrics,
    keyspace_hit_ratio: hits + misses === 0 ? 0 : round(hits / (hits + misses)),
    nodes
  };

  const outputDirectory = process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output";
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/redis-metrics-${label}.json`;
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputPath}`);
}

function usesDatabaseGlobalInfo(nodes: Array<ReturnType<typeof metricNode>>): boolean {
  if (nodes.length < 2) return false;
  const representative = nodes[0];
  return nodes.slice(1).every(
    (node) =>
      node.total_commands_processed === representative.total_commands_processed &&
      node.keyspace_hits === representative.keyspace_hits &&
      node.keyspace_misses === representative.keyspace_misses
  );
}

function metricNode(id: string, address: string, rawInfo: unknown) {
  if (typeof rawInfo !== "string") throw new Error("Redis INFO returned an unexpected response");
  const fields = parseInfo(rawInfo);
  const metrics = Object.fromEntries(METRIC_FIELDS.map((name) => [name, numericValue(fields[name])])) as Record<
    (typeof METRIC_FIELDS)[number],
    number
  >;
  return { id, address, ...metrics };
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

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
