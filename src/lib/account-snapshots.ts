import type { RedisClientType } from "redis";
import { jsonGet, jsonMGet, jsonSet } from "./json";
import { accountKey, securityKey, snapshotKey } from "./keys";
import { positionsByAccount, transactionsSearch } from "./queries";
import type {
  AccountRow,
  AccountSnapshot,
  PositionRow,
  SecurityRow,
  TransactionRow
} from "./types";

type PositionProjection = Omit<PositionRow, "payload">;
type SecurityProjection = Omit<SecurityRow, "payload">;

export type SnapshotRefreshResult = {
  status: "updated" | "rebuilt";
  transaction_added: boolean;
  position_updated: boolean;
  snapshot_key: string;
};

type SnapshotFunctionReply = {
  status: "updated" | "missing";
  transaction_added: boolean;
  position_updated: boolean;
};

export async function refreshAccountSnapshot(
  client: RedisClientType,
  input: {
    account: AccountRow;
    security: SecurityRow;
    transaction: TransactionRow;
    position: PositionProjection | null;
  }
): Promise<SnapshotRefreshResult> {
  const generatedAt = new Date().toISOString();
  let reply = await updateSnapshot(client, input, generatedAt);
  let status: SnapshotRefreshResult["status"] = "updated";

  if (reply.status === "missing") {
    const snapshot = await rebuildAccountSnapshot(client, input.account.account_id, {
      account: input.account
    });
    if (!snapshot) {
      throw new Error(`Unable to build account snapshot for ${input.account.account_id}`);
    }

    // The index-backed rebuild may or may not already contain the just-written
    // transaction. The Redis Function is idempotent for the retained recent
    // transaction window, so applying it again closes either case.
    reply = await updateSnapshot(client, input, generatedAt);
    if (reply.status === "missing") {
      throw new Error(`Account snapshot disappeared during refresh: ${input.account.account_id}`);
    }
    status = "rebuilt";
  }

  return {
    status,
    transaction_added: reply.transaction_added,
    position_updated: reply.position_updated,
    snapshot_key: snapshotKey(input.account.account_id)
  };
}

async function updateSnapshot(
  client: RedisClientType,
  input: {
    account: AccountRow;
    security: SecurityRow;
    transaction: TransactionRow;
    position: PositionProjection | null;
  },
  generatedAt: string
): Promise<SnapshotFunctionReply> {
  const raw = await client.sendCommand([
    "FCALL",
    "update_account_snapshot",
    "1",
    snapshotKey(input.account.account_id),
    JSON.stringify(stripPayload(input.transaction)),
    JSON.stringify(input.position),
    JSON.stringify(stripPayload(input.security)),
    generatedAt
  ]);
  return parseSnapshotFunctionReply(raw);
}

function parseSnapshotFunctionReply(raw: unknown): SnapshotFunctionReply {
  if (typeof raw !== "string") {
    throw new Error("update_account_snapshot returned an unexpected response");
  }

  const parsed = JSON.parse(raw) as Partial<SnapshotFunctionReply>;
  if (parsed.status !== "updated" && parsed.status !== "missing") {
    throw new Error("update_account_snapshot returned an invalid status");
  }
  if (typeof parsed.transaction_added !== "boolean") {
    throw new Error("update_account_snapshot returned an invalid transaction_added flag");
  }
  if (typeof parsed.position_updated !== "boolean") {
    throw new Error("update_account_snapshot returned an invalid position_updated flag");
  }

  return {
    status: parsed.status,
    transaction_added: parsed.transaction_added,
    position_updated: parsed.position_updated
  };
}

export async function rebuildAccountSnapshot(
  client: RedisClientType,
  accountId: string,
  options: {
    account?: AccountRow;
    securityByNo?: ReadonlyMap<string, SecurityProjection>;
    transactionLimit?: number;
  } = {}
): Promise<AccountSnapshot | null> {
  const account = options.account ?? (await jsonGet<AccountRow>(client, accountKey(accountId)));
  if (!account) return null;
  if (account.account_id !== accountId) {
    throw new Error(`Account ${account.account_id} cannot be used to build snapshot ${accountId}`);
  }

  const [positions, transactions] = await Promise.all([
    positionsByAccount({ client }, accountId),
    transactionsSearch({ client }, { accountId, limit: options.transactionLimit ?? 200 })
  ]);
  const securityByNo = await loadSecurityLookup(client, positions.data, options.securityByNo);

  const snapshot: AccountSnapshot = {
    _id: accountId,
    account_id: accountId,
    generated_at: new Date().toISOString(),
    account,
    position_count: positions.result_count,
    transaction_count: transactions.result_count,
    total_market_value: positions.data.reduce((sum, position) => sum + position.market_value, 0),
    recent_transactions: transactions.data.slice(0, 200).map(stripPayload),
    positions: positions.data.map((position) => ({
      ...stripPayload(position),
      security: securityByNo.get(position.security_no)
    }))
  };

  await jsonSet(client, snapshotKey(accountId), snapshot);
  return snapshot;
}

async function loadSecurityLookup(
  client: RedisClientType,
  positions: PositionRow[],
  provided?: ReadonlyMap<string, SecurityProjection>
): Promise<Map<string, SecurityProjection>> {
  const lookup = new Map(provided ?? []);
  const missingById = new Map<string, string>();
  for (const position of positions) {
    if (!lookup.has(position.security_no) && position.security_id) {
      missingById.set(position.security_id, position.security_no);
    }
  }

  const securityIds = [...missingById.keys()];
  const securities = await jsonMGet<SecurityRow>(client, securityIds.map(securityKey));
  for (const security of securities) {
    if (security) lookup.set(security.security_no, stripPayload(security));
  }
  return lookup;
}

function stripPayload<T extends { payload?: string }>(row: T): Omit<T, "payload"> {
  const { payload: _payload, ...rest } = row;
  return rest;
}
