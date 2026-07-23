import { randomUUID } from "node:crypto";
import { createIndexes } from "../src/lib/indexes";
import { jsonGet, jsonSet } from "../src/lib/json";
import { closeRedisClient, getRedisClient, sendRedisCommand } from "../src/lib/redis";

async function main() {
  const client = await getRedisClient();
  const info = await sendRedisCommand(client, ["INFO", "server"]);
  const version = typeof info === "string" ? info.match(/redis_version:([^\r\n]+)/)?.[1] : undefined;
  console.log(`Connected to Redis Cloud${version ? `, Redis ${version}` : ""}`);

  const probeId = randomUUID();
  const probeKey = `probe:${probeId}`;
  await jsonSet(client, probeKey, { probe_id: probeId, ok: true });
  const probe = await jsonGet<{ probe_id: string; ok: boolean }>(client, probeKey);
  if (!probe?.ok) {
    throw new Error("JSON.SET/JSON.GET probe failed");
  }
  await sendRedisCommand(client, ["DEL", probeKey]);
  console.log("JSON.SET/JSON.GET: ok");

  const results = await createIndexes(client);
  console.log("Redis Query Engine index check:");
  for (const result of results) {
    console.log(`- ${result}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
