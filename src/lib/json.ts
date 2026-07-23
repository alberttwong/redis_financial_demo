import { executeRedisPipeline, sendRedisCommand, type RedisConnection } from "./redis";

export async function jsonSet(client: RedisConnection, key: string, value: unknown): Promise<void> {
  await sendRedisCommand(client, jsonSetCommand(key, value));
}

export function jsonSetCommand(key: string, value: unknown): string[] {
  return ["JSON.SET", key, "$", JSON.stringify(value)];
}

export async function jsonGet<T>(client: RedisConnection, key: string): Promise<T | null> {
  const raw = await sendRedisCommand(client, ["JSON.GET", key, "$"]);
  return parseJsonGetReply<T>(raw);
}

export async function jsonMGet<T>(client: RedisConnection, keys: string[]): Promise<Array<T | null>> {
  if (keys.length === 0) return [];
  const raw = await executeRedisPipeline(client, keys.map((key) => ["JSON.GET", key, "$"]));
  return raw.map((value) => parseJsonGetReply<T>(value));
}

export async function jsonGetFields<T extends object>(
  client: RedisConnection,
  key: string,
  fields: readonly (keyof T & string)[]
): Promise<T | null> {
  const raw = await sendRedisCommand(client, jsonGetFieldsCommand(key, fields));
  return parseJsonFieldsReply<T>(raw, fields);
}

export async function jsonMGetFields<T extends object>(
  client: RedisConnection,
  keys: string[],
  fields: readonly (keyof T & string)[]
): Promise<Array<T | null>> {
  if (keys.length === 0) return [];

  const raw = await executeRedisPipeline(
    client,
    keys.map((key) => jsonGetFieldsCommand(key, fields))
  );
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
  const parsed = JSON.parse(value) as unknown;
  if (fields.length === 1 && Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    return { [fields[0]]: parsed[0] } as T;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const parsedFields = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let found = false;

  for (const field of fields) {
    const values = parsedFields[`$.${field}`];
    if (!Array.isArray(values) || values.length === 0) continue;
    result[field] = values[0];
    found = true;
  }

  return found ? (result as T) : null;
}
