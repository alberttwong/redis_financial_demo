import type { RedisClientType } from "redis";

export async function jsonSet(client: RedisClientType, key: string, value: unknown): Promise<void> {
  await client.sendCommand(["JSON.SET", key, "$", JSON.stringify(value)]);
}

export async function jsonGet<T>(client: RedisClientType, key: string): Promise<T | null> {
  const raw = await client.sendCommand(["JSON.GET", key, "$"]);
  if (!raw || typeof raw !== "string") return null;
  const parsed = JSON.parse(raw) as T[];
  return parsed[0] ?? null;
}

export async function jsonMGet<T>(client: RedisClientType, keys: string[]): Promise<Array<T | null>> {
  return Promise.all(keys.map((key) => jsonGet<T>(client, key)));
}
