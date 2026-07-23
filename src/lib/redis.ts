import {
  createClient,
  createCluster,
  type RedisClientType,
  type RedisClusterType
} from "redis";
import calculateSlot from "cluster-key-slot";
import { getRedisConfig } from "./config";

export type RedisConnection = RedisClientType | RedisClusterType;

let clientPromises: Array<Promise<RedisConnection>> | undefined;
let nextClientIndex = 0;

export async function getRedisClient(): Promise<RedisConnection> {
  if (!clientPromises) {
    const config = getRedisConfig();
    clientPromises = Array.from({ length: config.poolSize }, (_, index) =>
      createRedisConnection(index + 1, config.poolSize)
    );
  }

  const selected = clientPromises[nextClientIndex];
  nextClientIndex = (nextClientIndex + 1) % clientPromises.length;
  return selected;
}

export async function createRedisConnection(index = 1, total = 1): Promise<RedisConnection> {
  const config = getRedisConfig();
  if (config.clusterMode) {
    const tlsServerName = config.tls ? new URL(config.clusterRootNodes[0]).hostname : undefined;
    const cluster = createCluster({
      rootNodes: config.clusterRootNodes.map((url) => ({ url })),
      defaults: {
        username: config.username,
        password: config.password,
        socket: {
          tls: config.tls,
          servername: tlsServerName,
          connectTimeout: 10_000
        }
      },
      useReplicas: false
    }) as RedisClusterType;

    cluster.on("error", (error) => {
      console.error(`Redis cluster client ${index}/${total} error`, error);
    });
    await cluster.connect();
    return cluster;
  }

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
    console.error(`Redis client ${index}/${total} error`, error);
  });
  await client.connect();
  return client;
}

export async function sendRedisCommand<T = unknown>(
  client: RedisConnection,
  args: string[],
  options: { key?: string; readonly?: boolean } = {}
): Promise<T> {
  if (isRedisCluster(client)) {
    const key = options.key ?? redisCommandRoutingKey(args);
    const readonly = options.readonly ?? isReadonlyCommand(args[0]);
    return client.sendCommand<T>(key, readonly, args) as Promise<T>;
  }
  return client.sendCommand(args) as Promise<T>;
}

export async function executeRedisPipeline(
  client: RedisConnection,
  commands: string[][]
): Promise<unknown[]> {
  if (commands.length === 0) return [];
  if (isRedisCluster(client)) {
    return executeClusterPipeline(client, commands);
  }

  const pipeline = client.multi();
  for (const command of commands) pipeline.addCommand(command);
  return pipeline.execAsPipeline();
}

async function executeClusterPipeline(client: RedisClusterType, commands: string[][]): Promise<unknown[]> {
  type CommandGroup = {
    master: RedisClusterType["masters"][number];
    commands: string[][];
    resultIndexes: number[];
  };

  const groups = new Map<string, CommandGroup>();
  const unkeyed: Array<{ command: string[]; resultIndex: number }> = [];
  for (const [resultIndex, command] of commands.entries()) {
    const key = redisCommandRoutingKey(command);
    if (!key) {
      unkeyed.push({ command, resultIndex });
      continue;
    }

    const master = client.slots[calculateSlot(key)]?.master;
    if (!master) throw new Error(`Redis cluster has no primary for key ${key}`);
    const group = groups.get(master.id) ?? { master, commands: [], resultIndexes: [] };
    group.commands.push(command);
    group.resultIndexes.push(resultIndex);
    groups.set(master.id, group);
  }

  const results = new Array<unknown>(commands.length);
  await Promise.all([
    ...Array.from(groups.values(), async (group) => {
      const node = await client.nodeClient(group.master);
      const pipeline = node.multi();
      for (const command of group.commands) pipeline.addCommand(command);
      const replies = await pipeline.execAsPipeline();
      for (const [replyIndex, reply] of replies.entries()) {
        results[group.resultIndexes[replyIndex]] = reply;
      }
    }),
    ...unkeyed.map(async ({ command, resultIndex }) => {
      results[resultIndex] = await sendRedisCommand(client, command);
    })
  ]);
  return results;
}

export function isRedisCluster(client: RedisConnection): client is RedisClusterType {
  return "masters" in client && "slots" in client;
}

export function redisClusterMasters(client: RedisClusterType): RedisClusterType["masters"] {
  return Array.from(
    new Map(client.masters.map((master) => [`${master.id}@${master.address}`, master])).values()
  );
}

function redisCommandRoutingKey(args: string[]): string | undefined {
  const command = args[0]?.toUpperCase();
  if (command === "FCALL" || command === "FCALL_RO" || command === "EVAL" || command === "EVALSHA") {
    const keyCount = Number(args[2]);
    return keyCount > 0 ? args[3] : undefined;
  }

  if (
    command === "JSON.GET" ||
    command === "JSON.SET" ||
    command === "GET" ||
    command === "SET" ||
    command === "DEL" ||
    command === "EXISTS"
  ) {
    return args[1];
  }

  return undefined;
}

function isReadonlyCommand(command: string | undefined): boolean {
  return new Set([
    "EXISTS",
    "FT.INFO",
    "FT.PROFILE",
    "FT.SEARCH",
    "GET",
    "INFO",
    "JSON.GET"
  ]).has(command?.toUpperCase() ?? "");
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
