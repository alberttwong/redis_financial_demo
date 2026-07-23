const payloadCache = new Map<number, string>();
const payloadChunk = "LPL Redis Cloud financial serving row ".repeat(16);
const MAX_CACHED_PAYLOAD_LENGTHS = 4096;

export function withSizedPayload<T extends Record<string, unknown>>(row: T, targetBytes: number): T & { payload: string } {
  const base = { ...row, payload: "" };
  const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
  const payloadBytes = Math.max(targetBytes - baseBytes, 0);
  return {
    ...row,
    payload: makePayload(payloadBytes)
  };
}

function makePayload(bytes: number): string {
  if (bytes <= 0) return "";
  const cached = payloadCache.get(bytes);
  if (cached !== undefined) return cached;

  const payload = payloadChunk.repeat(Math.ceil(bytes / payloadChunk.length)).slice(0, bytes);
  if (payloadCache.size >= MAX_CACHED_PAYLOAD_LENGTHS) payloadCache.clear();
  payloadCache.set(bytes, payload);
  return payload;
}
