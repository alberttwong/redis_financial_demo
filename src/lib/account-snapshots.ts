import { createHash } from "node:crypto";
import { jsonGet, jsonMGetFields, jsonSet } from "./json";
import { accountKey, securityKey, snapshotKey } from "./keys";
import { SECURITY_PROJECTION_FIELDS } from "./projections";
import { positionsSearchByAccount, transactionsSearch } from "./queries";
import type { RedisConnection } from "./redis";
import type {
  AccountRow,
  AccountSnapshot,
  PositionProjection,
  SecurityProjection,
  TransactionProjection
} from "./types";

export async function rebuildAccountSnapshot(
  client: RedisConnection,
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
    positionsSearchByAccount({ client }, accountId),
    transactionsSearch({ client }, { accountId, limit: options.transactionLimit ?? 200 })
  ]);
  const securityByNo = await loadSecurityLookup(
    client,
    [...positions.data, ...transactions.data],
    options.securityByNo
  );

  const snapshot: AccountSnapshot = {
    _id: accountId,
    account_id: accountId,
    generated_at: new Date().toISOString(),
    revision: 0,
    account,
    position_count: positions.result_count,
    transaction_count: transactions.result_count,
    total_market_value: positions.data.reduce((sum, position) => sum + position.market_value, 0),
    recent_transactions: transactions.data.slice(0, 200).map((transaction) => ({
      ...transaction,
      security: securityByNo.get(transaction.security_no)
    })),
    position_index: Object.fromEntries(
      positions.data.map((position, index) => [snapshotPositionIndexKey(position._id), index])
    ),
    positions: positions.data.map((position) => ({
      ...position,
      security: securityByNo.get(position.security_no)
    }))
  };

  await jsonSet(client, snapshotKey(accountId), snapshot);
  return snapshot;
}

export function snapshotPositionIndexKey(positionId: string): string {
  return createHash("sha1").update(positionId).digest("hex");
}

async function loadSecurityLookup(
  client: RedisConnection,
  rows: Array<Pick<PositionProjection | TransactionProjection, "security_id" | "security_no">>,
  provided?: ReadonlyMap<string, SecurityProjection>
): Promise<Map<string, SecurityProjection>> {
  const lookup = new Map(provided ?? []);
  const missingById = new Map<string, string>();
  for (const row of rows) {
    if (!lookup.has(row.security_no) && row.security_id) {
      missingById.set(row.security_id, row.security_no);
    }
  }

  const securityIds = [...missingById.keys()];
  const securities = await jsonMGetFields<SecurityProjection>(
    client,
    securityIds.map(securityKey),
    SECURITY_PROJECTION_FIELDS
  );
  for (const security of securities) {
    if (security) lookup.set(security.security_no, security);
  }
  return lookup;
}
