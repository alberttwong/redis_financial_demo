import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  findRedisCloudString,
  redactRedisCloudSecrets
} from "../src/lib/redis-cloud-control-plane";

const [subscriptionId, databaseId, outputPath] = process.argv.slice(2);
const apiKey = process.env.REDISCLOUD_ACCESS_KEY;
const apiSecret = process.env.REDISCLOUD_SECRET_KEY;
const apiBase = (process.env.REDISCLOUD_API_BASE ?? "https://api.redislabs.com/v1").replace(
  /\/$/,
  ""
);

if (!subscriptionId || !databaseId || !outputPath) {
  throw new Error(
    "Usage: capture-redis-cloud-control-plane.ts <subscription-id> <database-id> <output-json-path>"
  );
}
if (!apiKey || !apiSecret) {
  throw new Error("REDISCLOUD_ACCESS_KEY and REDISCLOUD_SECRET_KEY are required.");
}

async function main() {
  const [subscription, database] = await Promise.all([
    fetchJson(`/subscriptions/${subscriptionId}`),
    fetchJson(`/subscriptions/${subscriptionId}/databases/${databaseId}`)
  ]);
  const output = {
    captured_at: new Date().toISOString(),
    subscription_id: subscriptionId,
    database_id: databaseId,
    prometheus_endpoint:
      findRedisCloudString(subscription, "prometheusEndpoint") ??
      process.env.REDISCLOUD_PROMETHEUS_ENDPOINT ??
      null,
    database_name: findRedisCloudString(database, "name"),
    subscription: redactRedisCloudSecrets(subscription),
    database: redactRedisCloudSecrets(database)
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  await chmod(outputPath, 0o600);
  console.log(`Wrote ${outputPath}`);
}

async function fetchJson(apiPath: string): Promise<unknown> {
  const response = await fetch(`${apiBase}${apiPath}`, {
    headers: {
      accept: "application/json",
      "x-api-key": apiKey as string,
      "x-api-secret-key": apiSecret as string
    },
    signal: AbortSignal.timeout(30_000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Redis Cloud API ${apiPath} returned HTTP ${response.status}: ${body.slice(0, 500)}`
    );
  }
  return JSON.parse(body);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
