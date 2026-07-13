"use client";

import { useEffect, useMemo, useState } from "react";

type Pattern = {
  id: string;
  label: string;
  group: string;
};

type QueryResult = {
  data?: unknown;
  timing?: {
    redis_ms: number;
    search_ms: number;
    hydrate_ms: number;
    join_ms: number;
    total_ms: number;
  };
  result_count?: number;
  payload_bytes?: number;
  commands?: string[];
  error?: string;
};

type QuerySamples = {
  account_id: string;
  security_id: string;
  security_no: string;
  acct_type_code: string;
  trade_date: string;
  transaction_id: string;
};

const patterns: Pattern[] = [
  { id: "accountById", label: "Account by ID", group: "Primary" },
  { id: "securityById", label: "Security by ID", group: "Primary" },
  { id: "securityByNo", label: "Security by No", group: "Secondary" },
  { id: "positionByComposite", label: "Position composite", group: "Primary" },
  { id: "positionsByAccount", label: "Positions by account", group: "Secondary" },
  { id: "transactionById", label: "Transaction by ID", group: "Primary" },
  { id: "transactionsByComposite", label: "Transactions by composite", group: "Secondary" },
  { id: "transactionsByAccount", label: "Transactions by account", group: "Secondary" },
  { id: "transactionsBySecurity", label: "Transactions by security", group: "Secondary" },
  { id: "transactionsByAccountSecurity", label: "Transactions by account + security", group: "Secondary" },
  { id: "accountPortfolioJoin", label: "Account portfolio join", group: "Join" },
  { id: "accountActivityJoin", label: "Account activity join", group: "Join" },
  { id: "accountSnapshot", label: "Materialized account snapshot", group: "Read model" }
];

export default function Home() {
  const [pattern, setPattern] = useState("accountById");
  const [accountId, setAccountId] = useState("A00000001");
  const [securityId, setSecurityId] = useState("SEC00000001");
  const [securityNo, setSecurityNo] = useState("SPX000001");
  const [acctTypeCode, setAcctTypeCode] = useState("CASH");
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().slice(0, 10));
  const [transactionId, setTransactionId] = useState("sample-transaction-id");
  const [limit, setLimit] = useState("100");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);

  const selected = useMemo(() => patterns.find((item) => item.id === pattern) ?? patterns[0], [pattern]);

  useEffect(() => {
    let cancelled = false;

    async function loadSamples() {
      try {
        const response = await fetch("/api/samples", { cache: "no-store" });
        const body = (await response.json()) as { samples?: QuerySamples };
        if (cancelled || !body.samples) return;

        setAccountId(body.samples.account_id);
        setSecurityId(body.samples.security_id);
        setSecurityNo(body.samples.security_no);
        setAcctTypeCode(body.samples.acct_type_code);
        setTradeDate(body.samples.trade_date);
        setTransactionId(body.samples.transaction_id);
      } catch {
        // Keep static fallbacks when Redis has not been seeded yet.
      }
    }

    void loadSamples();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runQuery() {
    setLoading(true);
    setResult(null);
    const params = new URLSearchParams({
      pattern,
      account_id: accountId,
      security_id: securityId,
      security_no: securityNo,
      acct_type_code: acctTypeCode,
      trade_date: tradeDate,
      transaction_id: transactionId,
      limit
    });

    try {
      const response = await fetch(`/api/query?${params.toString()}`);
      const body = (await response.json()) as QueryResult;
      setResult(body);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : "Query failed" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <p className="eyebrow">Redis Cloud 8.4</p>
          <h1>Financial Query Workbench</h1>
        </div>
        <a href="https://github.com/alberttwong/redis_financial_demo" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </section>

      <section className="grid">
        <aside className="panel controls">
          <label>
            Query pattern
            <select value={pattern} onChange={(event) => setPattern(event.target.value)}>
              {patterns.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.group} - {item.label}
                </option>
              ))}
            </select>
          </label>

          <div className="fields">
            <label>
              account_id
              <input value={accountId} onChange={(event) => setAccountId(event.target.value)} />
            </label>
            <label>
              security_id
              <input value={securityId} onChange={(event) => setSecurityId(event.target.value)} />
            </label>
            <label>
              security_no
              <input value={securityNo} onChange={(event) => setSecurityNo(event.target.value)} />
            </label>
            <label>
              acct_type_code
              <input value={acctTypeCode} onChange={(event) => setAcctTypeCode(event.target.value)} />
            </label>
            <label>
              trade_date
              <input value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} />
            </label>
            <label>
              transaction_id
              <input value={transactionId} onChange={(event) => setTransactionId(event.target.value)} />
            </label>
            <label>
              limit
              <input value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" />
            </label>
          </div>

          <button onClick={runQuery} disabled={loading}>
            {loading ? "Running..." : "Run query"}
          </button>
        </aside>

        <section className="panel results">
          <div className="resultHeader">
            <div>
              <p className="eyebrow">{selected.group}</p>
              <h2>{selected.label}</h2>
            </div>
            {result?.timing ? <span className="badge">{result.timing.total_ms} ms</span> : null}
          </div>

          {result?.error ? <div className="error">{result.error}</div> : null}

          {result?.timing ? (
            <div className="metrics">
              <Metric label="Redis" value={`${result.timing.redis_ms} ms`} />
              <Metric label="Search" value={`${result.timing.search_ms} ms`} />
              <Metric label="Hydrate" value={`${result.timing.hydrate_ms} ms`} />
              <Metric label="Join" value={`${result.timing.join_ms} ms`} />
              <Metric label="Rows" value={String(result.result_count ?? 0)} />
              <Metric label="Bytes" value={formatBytes(result.payload_bytes ?? 0)} />
            </div>
          ) : (
            <div className="empty">Run a query after seeding Redis Cloud.</div>
          )}

          {result?.commands?.length ? (
            <div className="commands">
              {result.commands.map((command) => (
                <code key={command}>{command}</code>
              ))}
            </div>
          ) : null}

          {result?.data !== undefined ? <pre>{JSON.stringify(result.data, null, 2)}</pre> : null}
        </section>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
