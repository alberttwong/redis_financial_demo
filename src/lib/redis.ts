import { createClient, type RedisClientType } from "redis";
import { getRedisConfig } from "./config";

let clientPromise: Promise<RedisClientType> | undefined;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!clientPromise) {
    const config = getRedisConfig();
    const client = createClient({
      url: config.url,
      username: config.username,
      password: config.password,
      socket: {
        tls: config.tls,
        connectTimeout: 10_000
      }
    }) as RedisClientType;

    client.on("error", (error) => {
      console.error("Redis client error", error);
    });

    clientPromise = client.connect().then(() => client);
  }

  return clientPromise;
}

export async function closeRedisClient(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = undefined;
  await client.quit();
}
