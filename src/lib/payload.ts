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
  const chunk = "LPL Redis Cloud financial serving row ".repeat(16);
  let payload = "";
  while (Buffer.byteLength(payload, "utf8") < bytes) {
    payload += chunk;
  }
  return payload.slice(0, bytes);
}
