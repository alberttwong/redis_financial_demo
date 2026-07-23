# Recommended Load-Test Sequence Results

Date: 2026-07-23 UTC

## Executive result

The recommended sequence was executed against the retained Redis Cloud dataset and a controlled 2x AWS scale-out.

- The highest mixed-load point that met the strict query objective was **2,555.09 of 2,556 reads/sec**, alongside **29,993.30 of 30,000 writes/sec**.
- At that point, all 12 query patterns had zero drops and zero errors. The worst p95 was 99 ms.
- The 100% point sustained **3,398.86 of 3,400 reads/sec** and **29,993.88 of 30,000 writes/sec**, but three heavyweight search patterns exceeded the 100 ms p95 objective.
- Redis reported zero blocked clients and zero rejected connections throughout the combined sequence.
- Sending `Accept-Encoding: gzip` did not enable compression. A raw response check found no `Content-Encoding` header and essentially identical wire size, so explicit API or reverse-proxy compression is required before a real compression experiment can be run.

The combined-load decision rule was at least 98% target achievement, no query drops or errors, and p95 no greater than 100 ms for every query pattern.

## Tested architecture

| Component | Retained capacity |
|---|---:|
| Query generators | 16 `c7i.large` instances |
| Write generators | 2 `c7i.large` instances |
| Light API pool | 32 `c7i.large` workers, 16 Redis clients/worker, concurrency 32 |
| Positions API pool | 8 workers, 8 Redis clients/worker, concurrency 8 |
| Transactions API pool | 16 workers, 16 Redis clients/worker, concurrency 16 |
| Portfolio API pool | 32 workers, 8 Redis clients/worker, concurrency 8 |
| Activity API pool | 32 workers, 16 Redis clients/worker, concurrency 16 |
| Snapshot API pool | 8 workers, 8 Redis clients/worker, concurrency 8 |
| Redis Cloud | OSS Cluster API enabled, 7 primaries |

The AWS fleet contains 146 `c7i.large` instances. At the observed public catalog rate of $0.08925 per instance-hour in `us-west-2`, EC2 compute is approximately **$13.03/hour**, excluding EBS, load balancers, data transfer, and Redis Cloud charges.

## Phase 1: isolated query capacity before scale-out

The isolated staircase used a 250 ms p95 ceiling, maximum 0.1% error rate, minimum 98% achievement, and a 1.3 capacity-headroom factor. Payload baselines were updated to match the retained large dataset before finalizing these results.

| Query pattern | API targets | Validated aggregate/sec | p50 ms | p95 ms | p99 ms | Average payload bytes |
|---|---:|---:|---:|---:|---:|---:|
| `accountById` | 16 | 7,998.02 | 6 | 13 | 22 | 196.29 |
| `securityById` | 16 | 7,998.00 | 7 | 17 | 25 | 8,192.00 |
| `securityByNo` | 16 | 7,997.73 | 12 | 17 | 24 | 332.56 |
| `positionByComposite` | 16 | 7,996.55 | 8 | 24 | 35 | 8,192.00 |
| `positionsByAccount` | 4 | 149.85 | 46 | 65 | 82 | 119,169.99 |
| `transactionById` | 16 | 3,999.22 | 4 | 7 | 9 | 8,192.00 |
| `transactionsByAccount` | 8 | 999.48 | 26 | 39 | 51 | 33,844.58 |
| `transactionsBySecurity` | 8 | 249.82 | 38 | 46 | 63 | 33,843.09 |
| `transactionsByAccountSecurity` | 16 | 3,998.98 | 9 | 12 | 16 | 3,126.21 |
| `accountPortfolioJoin` | 16 | 1,999.47 | 9 | 15 | 19 | 294,034.01 |
| `accountActivityJoin` | 16 | 3,999.05 | 9 | 18 | 23 | 136,857.52 |
| `accountSnapshot` | 4 | 499.87 | 10 | 16 | 23 | 430,865.09 |

The isolated results show that response size alone does not determine capacity. `transactionsBySecurity` returned about 33.8 KB but plateaued at approximately 250/sec, while the 294 KB materialized portfolio read reached approximately 2,000/sec. The search/index access path is the limiting factor for `transactionsBySecurity`.

## Phase 2: controlled 2x scale-out

The generator fleet increased from 9 to 18 instances while the API pools doubled. Redis Cloud capacity and the dataset were held constant.

| Heavy pattern | Scaled API targets | Validated aggregate/sec | p50 ms | p95 ms | p99 ms | Result versus prior |
|---|---:|---:|---:|---:|---:|---|
| `positionsByAccount` | 8 | 249.83 | 34 | 51 | 60 | 1.67x |
| `transactionsByAccount` | 16 | 1,998.70 | 30 | 47 | 58 | 2.00x |
| `transactionsBySecurity` | 16 | 249.80 | 37 | 45 | 64 | No gain |
| `accountPortfolioJoin` | 32 | 1,999.60 | 9 | 16 | 20 | Same validated step |
| `accountActivityJoin` | 32 | 3,998.92 | 7 | 14 | 19 | Same validated step |
| `accountSnapshot` | 8 | 999.77 | 9 | 14 | 18 | 2.00x |

`accountPortfolioJoin` and `accountActivityJoin` improved above their prior failure points, but the coarse staircase did not validate the next full step. The lack of movement for `transactionsBySecurity` is the clearest evidence that adding API workers alone will not scale every pattern.

## Phase 3: combined 12-query plus write staircase

The production query ratios were preserved. The two materialized joins each received five times the target of each standard pattern. Trade writes stayed fixed at 30,000/sec.

| Level | Query target/sec | Query achieved/sec | Query drops/errors | Worst query p95 | Write achieved/sec | Write p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| 25% | 856 | 855.46 | 0 / 0 | 52 ms | 29,995.13 | 9 ms | Pass |
| 50% | 1,700 | 1,699.28 | 0 / 0 | 57 ms | 29,989.39 | 9 ms | Pass |
| 75% | 2,556 | 2,555.09 | 0 / 0 | 99 ms | 29,993.30 | 10 ms | **Highest clean SLO point** |
| 100% | 3,400 | 3,398.86 | 0 / 0 | 136 ms | 29,993.88 | 16 ms | Throughput pass; latency fail |

Successful uncompressed HTTP response volume rose from approximately 114.19 MB/sec at 25% to 454.68 MB/sec at 100%.

### Full 100% query result

| Query pattern | Target/sec | Achieved/sec | p50 ms | p95 ms | p99 ms | Average payload bytes |
|---|---:|---:|---:|---:|---:|---:|
| `accountById` | 170 | 169.96 | 4 | 9 | 22 | 196.31 |
| `securityById` | 170 | 169.96 | 4 | 9 | 29 | 8,192.00 |
| `securityByNo` | 170 | 169.92 | 17 | 98 | 178 | 332.35 |
| `positionByComposite` | 170 | 169.96 | 5 | 10 | 40 | 8,192.00 |
| `positionsByAccount` | 170 | 169.86 | 41 | **136** | 238 | 119,172.18 |
| `transactionById` | 170 | 169.96 | 5 | 10 | 40 | 8,192.00 |
| `transactionsByAccount` | 170 | 169.90 | 24 | **102** | 181 | 33,844.39 |
| `transactionsBySecurity` | 170 | 169.86 | 37 | **115** | 195 | 33,842.29 |
| `transactionsByAccountSecurity` | 170 | 169.94 | 18 | 97 | 173 | 3,140.15 |
| `accountPortfolioJoin` | 850 | 849.79 | 10 | 16 | 30 | 294,031.71 |
| `accountActivityJoin` | 850 | 849.81 | 8 | 12 | 23 | 136,849.30 |
| `accountSnapshot` | 170 | 169.94 | 11 | 18 | 30 | 430,841.02 |
| **Total** | **3,400** | **3,398.86** |  |  |  |  |

The three p95 failures are all search/list patterns. The large materialized reads remained well below the objective, reinforcing that Redis query execution is more important than payload size for these specific patterns.

## Phase 4: HTTP compression check

The 100% workload was repeated with `QUERY_ACCEPT_ENCODING=gzip`.

| Mode | Query achieved/sec | Worst p95 | Reported body MB/sec | Write achieved/sec | Write p95 |
|---|---:|---:|---:|---:|---:|
| Identity | 3,398.86 | 136 ms | 454.68 | 29,993.88 | 16 ms |
| Gzip requested | 3,398.06 | 160 ms | 454.64 | 29,993.10 | 20 ms |

This was not an actual compressed-response test. A raw `accountSnapshot` request measured:

| Request header | Wire bytes | `Content-Encoding` |
|---|---:|---|
| `Accept-Encoding: identity` | 427,516 | Not present |
| `Accept-Encoding: gzip` | 427,517 | Not present |

The small latency difference between these two runs is normal run-to-run variation. It must not be interpreted as gzip CPU cost because the server returned identity responses in both cases.

## Conclusions and next action

1. Use **2,556 mixed query requests/sec plus 30,000 writes/sec** as the current strict SLO capacity of this tested topology.
2. Do not add more general API workers as the next experiment. The materialized joins and snapshot scale well, while `transactionsBySecurity` did not improve when its API pool doubled.
3. Optimize or replace the three heavyweight search/list paths, starting with `transactionsBySecurity`. Candidate work includes tighter index predicates, examining query execution plans and result materialization, and a dedicated projection when the required result semantics permit it.
4. Enable explicit gzip or Brotli at the API/reverse-proxy layer and rerun the identity-versus-compressed A/B. The current API response path does not compress.
5. Keep pool-specific admission limits. They prevented the heavyweight queries from causing head-of-line blocking in the lightweight and materialized-read pools.

## Retained environment verification

- All 128 API instances are `InService` at the tested desired capacities.
- All 18 generator instances remain provisioned.
- Redis Cloud 8.6.2 is reachable; JSON operations and all five query indexes pass health checks.
- Redis reported zero blocked clients and zero rejected connections after the final workload.
- The S3 RDB manifest remains at `s3://lpl-redis-benchmark-rdb-20260722222753244900000001/redis-cloud/latest.json`.
- No AWS or Redis Cloud resources were destroyed.

## Primary artifacts

- [Initial 12-query staircase](../memtier-output/aws-load-runner/query-staircase-sequence-20260723T034500Z/)
- [Corrected large-payload staircases](../memtier-output/aws-load-runner/query-staircase-corrected-20260723T044500Z/)
- [Low-rate positions staircase](../memtier-output/aws-load-runner/query-staircase-positions-low-20260723T050300Z/)
- [Scaled heavyweight staircase](../memtier-output/aws-load-runner/heavy-staircase-scaled-20260723T052000Z/)
- [25% combined run](../memtier-output/aws-load-runner/concurrent-18-hosts-sequence-25pct-20260723T060000Z/)
- [50% combined run](../memtier-output/aws-load-runner/concurrent-18-hosts-sequence-50pct-20260723T060107Z/)
- [75% combined run](../memtier-output/aws-load-runner/concurrent-18-hosts-sequence-75pct-20260723T060509Z/)
- [100% combined run](../memtier-output/aws-load-runner/concurrent-18-hosts-sequence-100pct-20260723T060854Z/)
- [Gzip-request comparison](../memtier-output/aws-load-runner/concurrent-18-hosts-sequence-100pct-gzip-20260723T061229Z/)
