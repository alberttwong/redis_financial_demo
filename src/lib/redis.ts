import {
  createClient,
  createCluster,
  type RedisClientType,
  type RedisClusterType
} from "redis";
import calculateSlot from "cluster-key-slot";
import { getRedisConfig } from "./config";

export type RedisConnection = RedisClientType | RedisClusterType;

type RedisClientState = {
  client?: RedisConnection;
  errorCount: number;
  lastErrorAt?: string;
};

type RedisPoolState = {
  clientPromises?: Array<Promise<RedisConnection>>;
  clientStates?: RedisClientState[];
  nextClientIndex: number;
};

const globalRedisPool = globalThis as typeof globalThis & {
  __lplRedisPool?: RedisPoolState;
};

function redisPoolState(): RedisPoolState {
  if (!globalRedisPool.__lplRedisPool) {
    globalRedisPool.__lplRedisPool = { nextClientIndex: 0 };
  }
  return globalRedisPool.__lplRedisPool;
}

export async function getRedisClient(): Promise<RedisConnection> {
  const pool = redisPoolState();
  if (!pool.clientPromises) {
    const config = getRedisConfig();
    pool.clientStates = Array.from({ length: config.poolSize }, () => ({ errorCount: 0 }));
    pool.clientPromises = pool.clientStates.map(async (state, index) => {
      try {
        const client = await createRedisConnection(index + 1, config.poolSize, () => {
          state.errorCount += 1;
          state.lastErrorAt = new Date().toISOString();
        });
        state.client = client;
        return client;
      } catch (error) {
        state.errorCount += 1;
        state.lastErrorAt = new Date().toISOString();
        throw error;
      }
    });
  }

  const selected = pool.clientPromises[pool.nextClientIndex];
  pool.nextClientIndex = (pool.nextClientIndex + 1) % pool.clientPromises.length;
  return selected;
}

export async function disconnectRedisPool(): Promise<void> {
  const pool = redisPoolState();
  const clients = (pool.clientStates ?? []).flatMap((state) =>
    state.client && state.client.isOpen ? [state.client] : []
  );
  await Promise.allSettled(clients.map((client) => client.disconnect()));
  delete globalRedisPool.__lplRedisPool;
}

export function readRedisConnectionMetrics() {
  const config = getRedisConfig();
  const states = redisPoolState().clientStates ?? [];
  const clients = states.flatMap((state) => (state.client ? [state.client] : []));
  return {
    configured_pool_size: config.poolSize,
    allocated_clients: states.length,
    initialized_clients: clients.length,
    connecting_clients: states.filter((state) => !state.client && state.errorCount === 0).length,
    failed_clients: states.filter((state) => !state.client && state.errorCount > 0).length,
    open_clients: clients.filter((client) => client.isOpen).length,
    ready_clients: clients.filter(isRedisConnectionReady).length,
    cluster_clients: clients.filter(isRedisCluster).length,
    error_count: states.reduce((total, state) => total + state.errorCount, 0),
    last_error_at:
      states
        .flatMap((state) => (state.lastErrorAt ? [state.lastErrorAt] : []))
        .sort()
        .at(-1) ?? null
  };
}

function isRedisConnectionReady(client: RedisConnection): boolean {
  return "isReady" in client ? Boolean(client.isReady) : client.isOpen;
}

export async function createRedisConnection(
  index = 1,
  total = 1,
  onError?: (error: unknown) => void
): Promise<RedisConnection> {
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
      onError?.(error);
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
    onError?.(error);
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
  const pool = redisPoolState();
  if (!pool.clientPromises) return;
  const pendingClients = pool.clientPromises;
  pool.clientPromises = undefined;
  pool.clientStates = undefined;
  pool.nextClientIndex = 0;
  await Promise.all(
    pendingClients.map(async (pendingClient) => {
      const client = await pendingClient;
      if (client.isOpen) await client.quit();
    })
  );
}
