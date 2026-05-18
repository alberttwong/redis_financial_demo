import type { RedisClientType } from "redis";

export type SearchKeysOptions = {
  limit?: number;
  offset?: number;
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
