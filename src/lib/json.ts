import type { RedisClientType } from "redis";

export async function jsonSet(client: RedisClientType, key: string, value: unknown): Promise<void> {
  await client.sendCommand(jsonSetCommand(key, value));
}

export function jsonSetCommand(key: string, value: unknown): string[] {
  return ["JSON.SET", key, "$", JSON.stringify(value)];
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

export async function jsonGetFields<T extends object>(
  client: RedisClientType,
  key: string,
  fields: readonly (keyof T & string)[]
): Promise<T | null> {
  const raw = await client.sendCommand(jsonGetFieldsCommand(key, fields));
  return parseJsonFieldsReply<T>(raw, fields);
}

export async function jsonMGetFields<T extends object>(
  client: RedisClientType,
  keys: string[],
  fields: readonly (keyof T & string)[]
): Promise<Array<T | null>> {
  if (keys.length === 0) return [];

  const pipeline = client.multi();
  for (const key of keys) {
    pipeline.addCommand(jsonGetFieldsCommand(key, fields));
  }

  const raw = await pipeline.execAsPipeline();
  return raw.map((value) => parseJsonFieldsReply<T>(value, fields));
}

function jsonGetFieldsCommand<T extends object>(key: string, fields: readonly (keyof T & string)[]): string[] {
  if (fields.length === 0) throw new Error("At least one JSON field is required");
  return ["JSON.GET", key, ...fields.map((field) => `$.${field}`)];
}

function parseJsonGetReply<T>(value: unknown): T | null {
  if (!value || typeof value !== "string") return null;
  const parsed = JSON.parse(value) as T[];
  return parsed[0] ?? null;
}

function parseJsonFieldsReply<T extends object>(
  value: unknown,
  fields: readonly (keyof T & string)[]
): T | null {
  if (!value || typeof value !== "string") return null;
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let found = false;

  for (const field of fields) {
    const values = parsed[`$.${field}`];
    if (!Array.isArray(values) || values.length === 0) continue;
    result[field] = values[0];
    found = true;
  }

  return found ? (result as T) : null;
}
