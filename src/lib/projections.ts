import type { PositionProjection, SecurityProjection, TransactionProjection } from "./types";

export const SECURITY_PROJECTION_FIELDS = [
  "_id",
  "security_id",
  "security_no",
  "symbol",
  "cusip",
  "asset_class",
  "index_name",
  "index_member",
  "sector",
  "industry",
  "exchange",
  "issuer_name",
  "status"
] as const satisfies readonly (keyof SecurityProjection)[];

export const POSITION_PROJECTION_FIELDS = [
  "_id",
  "account_id",
  "security_id",
  "security_no",
  "acct_type_code",
  "quantity",
  "market_value",
  "as_of_date",
  "projection_version"
] as const satisfies readonly (keyof PositionProjection)[];

export const TRANSACTION_PROJECTION_FIELDS = [
  "_id",
  "transaction_id",
  "account_id",
  "security_id",
  "security_no",
  "trade_date",
  "trade_date_epoch",
  "acct_type_code",
  "transaction_type",
  "quantity",
  "amount"
] as const satisfies readonly (keyof TransactionProjection)[];
