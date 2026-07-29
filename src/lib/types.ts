export type AccountRow = {
  _id: string;
  account_id: string;
  household_id: string;
  advisor_id: string;
  account_type: string;
  registration_type: string;
  status: string;
  opened_date: string;
};

export type SecurityRow = {
  _id: string;
  security_id: string;
  security_no: string;
  symbol: string;
  cusip: string;
  asset_class: string;
  index_name: string;
  index_member: boolean;
  sector: string;
  industry: string;
  exchange: string;
  issuer_name: string;
  status: string;
  payload: string;
};

export type PositionRow = {
  _id: string;
  account_id: string;
  security_id: string;
  security_no: string;
  acct_type_code: string;
  quantity: number;
  market_value: number;
  as_of_date: string;
  projection_version: number;
  payload: string;
};

export type TransactionRow = {
  _id: string;
  transaction_id: string;
  account_id: string;
  security_id: string;
  security_no: string;
  trade_date: string;
  trade_date_epoch: number;
  acct_type_code: string;
  transaction_type: string;
  quantity: number;
  amount: number;
  payload: string;
};

export type SecurityProjection = Omit<SecurityRow, "payload">;
export type PositionProjection = Omit<PositionRow, "payload">;
export type TransactionProjection = Omit<TransactionRow, "payload">;

export type AccountSnapshot = {
  _id: string;
  account_id: string;
  generated_at: string;
  revision: number;
  account: AccountRow;
  position_count: number;
  transaction_count: number;
  total_market_value: number;
  recent_transactions: Array<TransactionProjection & { security?: SecurityProjection }>;
  position_index: Record<string, number>;
  positions: Array<PositionProjection & { security?: SecurityProjection }>;
};

export type Timings = {
  queue_ms: number;
  redis_ms: number;
  search_ms: number;
  hydrate_ms: number;
  join_ms: number;
  total_ms: number;
};

export type QueryResult<T> = {
  data: T;
  timing: Timings;
  result_count: number;
  redis_command_count: number;
  commands: string[];
};

export type QueryResponse<T> = QueryResult<T> & {
  payload_bytes: number;
};

export type SeedCounts = {
  accounts: number;
  securities: number;
  positions: number;
  transactions: number;
  snapshots: number;
};
