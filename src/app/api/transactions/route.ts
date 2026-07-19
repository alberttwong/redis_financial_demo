import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { accountKey, securityKey, transactionDocumentId } from "@/lib/keys";
import { jsonGet } from "@/lib/json";
import { getRedisClient } from "@/lib/redis";
import { applyTransaction, TRANSACTION_TYPES, type TransactionType } from "@/lib/transaction-writes";
import type { AccountRow, SecurityRow, TransactionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = asObject(await request.json());
    const accountId = requiredString(body, "account_id");
    const securityId = requiredString(body, "security_id");
    const acctTypeCode = requiredString(body, "acct_type_code");
    const transactionType = requiredTransactionType(body);
    const quantity = requiredNumber(body, "quantity");
    const amount = requiredNumber(body, "amount");
    const tradeDate = optionalString(body, "trade_date") ?? new Date().toISOString().slice(0, 10);
    const transactionId = optionalString(body, "transaction_id") ?? randomUUID();
    const payload = optionalString(body, "payload") ?? "";
    const tradeDateEpoch = Date.parse(`${tradeDate}T00:00:00.000Z`);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) ||
      !Number.isFinite(tradeDateEpoch) ||
      new Date(tradeDateEpoch).toISOString().slice(0, 10) !== tradeDate
    ) {
      throw new InputError("trade_date must use YYYY-MM-DD format");
    }
    if (quantity <= 0) {
      throw new InputError("quantity must be greater than zero");
    }

    const client = await getRedisClient();
    const [account, security] = await Promise.all([
      jsonGet<AccountRow>(client, accountKey(accountId)),
      jsonGet<SecurityRow>(client, securityKey(securityId))
    ]);
    if (!account) throw new InputError(`Unknown account_id: ${accountId}`);
    if (!security) throw new InputError(`Unknown security_id: ${securityId}`);

    const transaction: TransactionRow = {
      _id: transactionDocumentId(accountId, securityId, transactionId),
      transaction_id: transactionId,
      account_id: accountId,
      security_id: securityId,
      security_no: security.security_no,
      trade_date: tradeDate,
      trade_date_epoch: tradeDateEpoch,
      acct_type_code: acctTypeCode,
      transaction_type: transactionType,
      quantity,
      amount,
      payload
    };
    const applied = await applyTransaction(client, transaction, security);
    const { position_projection: _positionProjection, ...result } = applied;
    const snapshot = {
      status: result.status === "inserted" ? "updated" : "unchanged",
      transaction_added: result.transaction_added,
      position_updated: result.position_updated,
      snapshot_key: result.snapshot_key,
      revision: result.projection_revision
    };

    return NextResponse.json(
      {
        transaction: { ...transaction, payload: undefined },
        result,
        snapshot
      },
      { status: result.status === "inserted" ? 201 : 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to apply transaction" },
      { status: error instanceof InputError ? 400 : 500 }
    );
  }
}

class InputError extends Error {}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = optionalString(body, field);
  if (!value) throw new InputError(`${field} must be a non-empty string`);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new InputError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InputError(`${field} must be a finite number`);
  }
  return value;
}

function requiredTransactionType(body: Record<string, unknown>): TransactionType {
  const value = requiredString(body, "transaction_type").toUpperCase();
  if (!TRANSACTION_TYPES.includes(value as TransactionType)) {
    throw new InputError(`transaction_type must be one of: ${TRANSACTION_TYPES.join(", ")}`);
  }
  return value as TransactionType;
}
