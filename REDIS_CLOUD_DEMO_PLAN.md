# Redis Cloud 8.4 LPL SQL-Batch Demo Plan

## Summary

Build a Node/TypeScript web and API demo that uses Redis Cloud 8.4 as the runtime Redis database. SQL source data is assumed to be batch-loaded into Redis table by table, with one flat JSON document per SQL row. The demo will show how Redis Cloud can serve primary-key lookups, secondary-index searches, selected Elasticsearch-style query patterns, DynamoDB-style key access, and Postgres-style read joins through API-layer hydration and materialized read models.

GitHub repository: `https://github.com/alberttwong/redis_financial_demo`

This file is documentation only. It does not create app code, Terraform resources, or Redis Cloud infrastructure.

## Redis Cloud Terraform Provisioning

Provision Redis Cloud with Terraform under `infra/redis-cloud`.

Defaults:

- Runtime target: Redis Cloud 8.4
- Subscription type: Redis Cloud Pro/Flexible
- Cloud provider and region: AWS `us-west-2`
- Subscription name: `lpl-redis-demo`
- Database name: `lpl-query-patterns`
- Dataset size: 20 GB
- Throughput sizing: 180,000 operations per second
- Endpoint access: public endpoint for local demo development. Use the Terraform `redis_tls` output to decide whether the app should use `redis://` or `rediss://`.
- Eviction policy: `noeviction`, unless a later benchmark explicitly tests cache-style eviction

Terraform should use the Redis Cloud account's default payment method. Redis Cloud API credentials should come from environment variables:

```sh
REDISCLOUD_ACCESS_KEY
REDISCLOUD_SECRET_KEY
```

The Terraform configuration should use Redis Cloud Pro/Flexible resources by default with `dataset_size_in_gb = 20`, `throughput_measurement_by = "operations-per-second"`, and `throughput_measurement_value = 180000`. Essentials should remain available as an explicit smaller-demo override, but Pro/Flexible is the default target for the performance demo.

Switching an existing Terraform-managed Essentials deployment to the default Pro/Flexible resource family creates Pro/Flexible resources and removes the Essentials resources from that state. Export or reseed demo data before applying that replacement.

Expected Terraform outputs:

- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_TLS`, from the Terraform `redis_tls` output
- `REDIS_DATABASE_NAME`
- `REDISCLOUD_SUBSCRIPTION_ID`
- `REDISCLOUD_DATABASE_ID`
- Sensitive `REDIS_PASSWORD`
- Sensitive `REDIS_URL` connection string

Generated `.env` files with real credentials must not be committed.

## Table-By-Table SQL Batch Load Model

SQL remains the source of truth. Redis Cloud is the serving, search, and read-model layer.

Data is batched into Redis table by table, not streamed row by row through CDC for this demo. Load order should preserve dependencies:

1. `accounts`
2. `securities`
3. `positions`
4. `transactions`
5. Materialized read models, such as account snapshots

Each SQL row becomes one flat Redis JSON document with SQL-friendly top-level field names. Use source-like names such as:

- `account_id`
- `security_id`
- `security_no`
- `transaction_id`
- `acct_type_code`
- `trade_date`
- `advisor_id`
- `household_id`
- `status`

Large non-indexed row content should live in a `payload` field so Redis Query Engine indexes remain narrow. Account rows are compact metadata documents and should not include synthetic payloads.

Account information documents are compact metadata rows. A single account-by-id lookup should return the full account JSON document, not a trimmed projection.

Position and transaction documents should support configurable payload sizes up to 400KB for stress and transfer-size tests.

Batch loaders should use Redis pipelines with a configurable flush size, for example 500 or 1000 rows per batch.

## Faker Data Generation

Use `@faker-js/faker` in Node/TypeScript to generate synthetic LPL-style financial services data. Securities mimic an S&P 500-style equity universe with large-cap anchor companies, sector/industry metadata, exchange, and `index_name = "S&P 500"`.

Generation should be deterministic when a seed is provided, so benchmark and demo runs can be reproduced.

Planned generation scripts:

```sh
npm run seed:accounts
npm run seed:securities
npm run seed:positions
npm run seed:transactions
npm run seed:snapshots
npm run seed:all
```

The generator should maintain referential consistency:

- Positions reference generated accounts and securities.
- Transactions reference generated accounts and securities.
- Materialized snapshots are built from already-loaded base rows.

Document size targets:

- Account Info: compact metadata row with no synthetic payload
- Security Info: configurable up to 100KB, S&P 500-style equity rows
- Position: configurable up to 400KB
- Transaction: configurable up to 400KB

Example account row shape:

```json
{
  "account_id": "A00012345",
  "household_id": "HH000882",
  "advisor_id": "ADV00912",
  "account_type": "BROKERAGE",
  "registration_type": "INDIVIDUAL",
  "status": "ACTIVE",
  "opened_date": "2018-04-12"
}
```

## Redis JSON Key And Index Model

Use Redis JSON for row storage and Redis Query Engine for secondary lookup.

Primary Redis keys:

```text
acct:{account_id}:info
sec:{security_id}:info
pos:{account_id}:{security_no}:{acct_type_code}
txn:{pos:account_id:security_no:acct_type_code}:{transaction_id}
acct-snapshot:{account_id}
```

Access pattern mapping:

| Dataset | Redis key | Primary lookup | Secondary lookup |
| --- | --- | --- | --- |
| Account Info | `acct:{account_id}:info` | `account_id` | None |
| Security Info | `sec:{security_id}:info` | `security_id` | `security_no` |
| Position | `pos:{account_id}:{security_no}:{acct_type_code}` | Composite key | `account_id` |
| Transaction | `txn:{pos:account_id:security_no:acct_type_code}:{transaction_id}` | Position identity + transaction id | `account_id`, `security_id`, combined filters |

Use direct `JSON.GET` for primary and composite-key reads.

Use narrow `ON JSON` indexes with explicit key prefixes. Index only fields used by query patterns:

- Account index: `account_id`
- Security index: `security_id`, `security_no`
- Position index: `_id`, `account_id`, `security_no`, `acct_type_code`
- Transaction index: `_id`, `account_id`, `security_id`, `trade_date`, `acct_type_code`

Use Redis Query Engine field types intentionally:

- `TAG` for exact IDs and codes
- `NUMERIC` for dates or ranges when needed
- No index on large `payload` fields

Use `DIALECT 2` for all `FT.SEARCH` and `FT.AGGREGATE` examples.

## UI And API Timed Query Behavior

The UI and API should expose the same query examples.

Individual lookup examples:

- Account by `account_id`, returning the full compact account JSON document
- Security by `security_id`
- Security by `security_no`
- Position by composite key
- Position by `account_id`
- Transaction by position identity and `transaction_id`
- Transaction by `account_id`
- Transaction by `security_id`
- Transaction by combined `account_id` and `security_id`

Every API response should include timing metadata:

```json
{
  "timing": {
    "redis_ms": 0,
    "search_ms": 0,
    "hydrate_ms": 0,
    "join_ms": 0,
    "total_ms": 0
  },
  "result_count": 0,
  "payload_bytes": 0,
  "redis_command_count": 0,
  "commands": []
}
```

Timing should use high-resolution Node timers, such as `performance.now()`.

The UI should display:

- Primary lookup latency
- Secondary-index search latency
- Join and hydration latency
- Total API latency
- Result count
- Response size in bytes
- Sanitized Redis command shapes

The API should not return secrets or raw credential-bearing connection strings in command examples.

## Join Strategy And Materialized Read Models

Redis Query Engine is not a relational SQL join planner. Runtime joins should happen in the API layer.

Runtime join flow:

1. Use `JSON.GET` when the primary key is known.
2. Use `FT.SEARCH RETURN` to retrieve matching collection rows with only the required JSON fields when a secondary lookup is required.
3. Start independent account and collection reads concurrently.
4. Use pipelined multi-path `JSON.GET` calls only for related security rows; do not transfer synthetic payloads for collection or join reads.
5. Assemble the joined response in the API layer.
6. Return timing metadata for search, hydration, join assembly, and total request time.

Join examples:

- Account + positions + securities
- Account + transactions + securities
- Security exposure across positions and transactions
- Transaction detail + account + security

For hot joins, maintain materialized Redis JSON read models after base table loads.

Primary materialized example:

```text
acct-snapshot:{account_id}
```

The snapshot can include:

- Account summary
- Position summaries
- Security summaries
- Recent transaction summaries
- Precomputed totals

The UI should compare runtime join timing against materialized snapshot timing so the demo shows the Redis-native approach for replacing high-volume Postgres read joins.

## Query And Trade-Write Load Profiles

The 12 query-pattern profiles call `/api/query` so each load test follows the same direct lookup, projected secondary search, optional related-security hydration, join, and response path as the browser workbench. The default concurrent targets are:

- `accountPortfolioJoin`: 50,000 reads/sec
- `accountActivityJoin`: 50,000 reads/sec
- Ten other query patterns: 10,000 reads/sec each
- Atomic transaction writes: 30,000 writes/sec

The combined target is 230,000 client operations/sec. It is not a Redis command-rate target: collection searches use one projected `FT.SEARCH`, while joins still issue additional account and related-security reads. Query runners use persistent HTTP connections and valid seeded identifiers from `/api/samples`, and record both HTTP request rate and estimated Redis command rate. The transaction writer uses `memtier_benchmark` with `FCALL apply_transaction`, unique transaction keys, tunable threads, clients, pipeline depth, and a total target rate that is divided across connections.

`transactionsByComposite` remains a workbench query but is outside this 12-query concurrent load profile.

Large-document query results should report both:

- Requests per second
- Estimated Redis commands per second
- Response throughput in MB/sec

Benchmark output should capture:

- Target and achieved client ops/sec
- Estimated target and achieved Redis ops/sec
- p50 latency
- p99 latency
- p99.9 latency
- Error rate
- Test duration
- Workload or query pattern
- Redis Cloud endpoint metadata without secrets

## Validation And Smoke Tests

Add a future Redis Cloud validation script that verifies:

- TLS connection succeeds
- Redis server version is available
- Redis JSON commands work with `JSON.SET` and `JSON.GET`
- Redis Query Engine commands work with `FT.CREATE` and `FT.SEARCH`

Add a smoke test flow:

1. Create or recreate indexes.
2. Seed a small table-by-table dataset.
3. Verify one account document has no synthetic payload field.
4. Run primary account lookup.
5. Run security secondary lookup.
6. Run position secondary lookup.
7. Run transaction secondary lookup.
8. Run runtime join examples.
9. Build and read an account materialized snapshot.
10. Print timing summaries.

Unit and integration test coverage should include:

- Redis key builders
- Composite key parsing
- Redis TAG escaping
- Faker generation determinism
- Payload size generation
- Table-by-table loader order
- Index creation
- Secondary searches
- Join hydration
- Materialized snapshot generation
- Timing metadata shape

## Assumptions

- Redis Cloud is the only Redis runtime target.
- Terraform provisions Redis Cloud infrastructure.
- Terraform uses the Redis Cloud account's default payment method.
- Redis Cloud Pro/Flexible in AWS `us-west-2`, Redis 8.4, 20 GB dataset size, and 180,000 operations per second is the default target.
- SQL remains the source of truth.
- Redis receives batched table extracts, not streaming CDC, for this demo.
- Account info documents are compact metadata rows without synthetic payloads and are returned in full for single-account reads.
- Redis is used as a high-performance serving, search, and read-model layer, not as a relational SQL join engine.
