export function findRedisCloudString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
  ) {
    return (value as Record<string, string>)[key];
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findRedisCloudString(item, key);
        if (found) return found;
      }
    } else {
      const found = findRedisCloudString(child, key);
      if (found) return found;
    }
  }
  return null;
}

export function redactRedisCloudSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRedisCloudSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redactRedisCloudSecrets(child)
    ])
  );
}

function isSensitiveKey(key: string): boolean {
  return /(password|secret|authToken|apiKey|privateKey|certificate)/i.test(key);
}
