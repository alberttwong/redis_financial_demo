import type { RedisClientType } from "redis";

export async function jsonSet(client: RedisClientType, key: string, value: unknown): Promise<void> {
  await client.sendCommand(["JSON.SET", key, "$", JSON.stringify(value)]);
}

export async function jsonGet<T>(client: RedisClientType, key: string): Promise<T | null> {
  const raw = await client.sendCommand(["JSON.GET", key, "$"]);
  return parseJsonGetReply<T>(raw);
}

export async function jsonMGet<T>(client: RedisClientType, keys: string[]): Promise<Array<T | null>> {
  if (keys.length === 0) return [];

  const pipeline = client.multi();
  for (const key of keys) {
    pipeline.addCommand(["JSON.GET", key, "$"]);
  }

  const raw = await pipeline.execAsPipeline();
  return raw.map((value) => parseJsonGetReply<T>(value));
}

function parseJsonGetReply<T>(value: unknown): T | null {
  if (!value || typeof value !== "string") return null;
  const parsed = JSON.parse(value) as T[];
  return parsed[0] ?? null;
}
