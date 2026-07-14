import type { RedisClientType } from "redis";

export type SearchKeysOptions = {
  limit?: number;
  offset?: number;
};

export type SearchProjectedResult<T> = {
  total: number;
  rows: T[];
};

export async function searchKeys(
  client: RedisClientType,
  index: string,
  query: string,
  options: SearchKeysOptions = {}
): Promise<{ total: number; keys: string[] }> {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  const raw = await client.sendCommand([
    "FT.SEARCH",
    index,
    query,
    "NOCONTENT",
    "LIMIT",
    String(offset),
    String(limit),
    "DIALECT",
    "2"
  ]);

  if (!Array.isArray(raw)) return { total: 0, keys: [] };
  const [total, ...keys] = raw;
  return {
    total: Number(total ?? 0),
    keys: keys.filter((value): value is string => typeof value === "string")
  };
}

export async function searchProjected<T extends object>(
  client: RedisClientType,
  index: string,
  query: string,
  fields: readonly (keyof T & string)[],
  options: SearchKeysOptions = {}
): Promise<SearchProjectedResult<T>> {
  if (fields.length === 0) throw new Error("At least one search projection field is required");

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 100;
  const returnArguments = fields.flatMap((field) => [`$.${field}`, "AS", field]);
  const raw = await client.sendCommand([
    "FT.SEARCH",
    index,
    query,
    "RETURN",
    String(returnArguments.length),
    ...returnArguments,
    "LIMIT",
    String(offset),
    String(limit),
    "DIALECT",
    "2"
  ]);

  return parseProjectedSearchReply<T>(raw, fields);
}

function parseProjectedSearchReply<T extends object>(
  raw: unknown,
  fields: readonly (keyof T & string)[]
): SearchProjectedResult<T> {
  if (!Array.isArray(raw)) return { total: 0, rows: [] };

  const total = Number(raw[0] ?? 0);
  const allowedFields = new Set<string>(fields);
  const rows: T[] = [];

  for (let index = 1; index < raw.length; index += 2) {
    const key = raw[index];
    const attributes = raw[index + 1];
    if (typeof key !== "string" || !Array.isArray(attributes)) continue;

    const row: Record<string, unknown> = {};
    for (let attributeIndex = 0; attributeIndex < attributes.length - 1; attributeIndex += 2) {
      const field = attributes[attributeIndex];
      if (typeof field !== "string" || !allowedFields.has(field)) continue;
      row[field] = parseSearchValue(attributes[attributeIndex + 1]);
    }

    rows.push(row as T);
  }

  return {
    total: Number.isFinite(total) ? total : 0,
    rows
  };
}

function parseSearchValue(value: unknown): unknown {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
