# Redis Financial Demo

Demo app for SQL-batched financial data in Redis Cloud 8.4. The app stores flat SQL-friendly JSON rows in Redis Cloud, creates narrow Redis Query Engine indexes, exposes timed UI/API query examples, and includes Faker seeders plus `memtier_benchmark` workload helpers.

GitHub repository: <https://github.com/alberttwong/redis_financial_demo>

## Quick Start

```sh
npm install
cp .env.example .env.local
npm run redis:check
npm run redis:indexes
npm run seed:all
npm run smoke
npm run dev
```

Open <http://localhost:3000>.

## Query Examples

- Account by `account_id`, returning the full ~100KB JSON row.
- Security by `security_id` or `security_no`.
- Position by composite id or `account_id`.
- Transaction by composite id, `account_id`, `security_id`, or combined filters.
- Runtime joins for account portfolios, account activity, security exposure, and transaction detail.
- Materialized account snapshot lookup for hot join/read-model comparisons.

## Redis Cloud

Redis Cloud credentials are read from environment variables. Use the Terraform `redis_url` and `redis_tls` outputs for the exact protocol of the provisioned database.

See [REDIS_CLOUD_DEMO_PLAN.md](./REDIS_CLOUD_DEMO_PLAN.md) for the full implementation plan.
