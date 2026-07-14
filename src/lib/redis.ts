import { createClient, type RedisClientType } from "redis";
import { getRedisConfig } from "./config";

let clientPromises: Array<Promise<RedisClientType>> | undefined;
let nextClientIndex = 0;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!clientPromises) {
    const config = getRedisConfig();
    clientPromises = Array.from({ length: config.poolSize }, (_, index) => {
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
        console.error(`Redis client ${index + 1}/${config.poolSize} error`, error);
      });

      return client.connect().then(() => client);
    });
  }

  const selected = clientPromises[nextClientIndex];
  nextClientIndex = (nextClientIndex + 1) % clientPromises.length;
  return selected;
}

export async function closeRedisClient(): Promise<void> {
  if (!clientPromises) return;
  const pendingClients = clientPromises;
  clientPromises = undefined;
  nextClientIndex = 0;
  await Promise.all(
    pendingClients.map(async (pendingClient) => {
      const client = await pendingClient;
      if (client.isOpen) await client.quit();
    })
  );
}
