# Optimized Query and HTTP Compression Results

Date: 2026-07-23 UTC

## Executive result

The retained 128-worker API fleet, 18 load generators, seven-primary Redis
Cloud database, and approximately 2 TB dataset were tested after two changes:

1. `positionsByAccount` and `transactionsByAccount` now read the synchronously
   maintained account snapshot instead of executing full-text searches.
   `transactionsBySecurity` retains its indexed search semantics but uses
   DIALECT 4, sortable date ordering, and `WITHOUTCOUNT`.
2. The query API now returns gzip responses when the client sends
   `Accept-Encoding: gzip`.

At the 100% point, the system achieved **3,398.99 of 3,400 HTTP reads/sec**
and **29,995.71 of 30,000 writes/sec** with zero query drops or errors.
The worst query p95 improved from 136 ms in the prior identity-response run
to 112 ms. The run still missed the strict 100 ms p95 objective on three
remaining indexed-search patterns.

Gzip reduced successful response traffic from **454.24 MB/sec to
53.72 MB/sec**, an **88.2% reduction**, without reducing achieved throughput.
It did add API CPU latency to the largest responses: `accountPortfolioJoin`
p95 increased from 16 ms to 34 ms and `accountSnapshot` from 17 ms to 41 ms
in the matched 100% control.

## Test architecture

| Component | Capacity |
|---|---:|
| Query generators | 16 `c7i.large` instances |
| Write generators | 2 `c7i.large` instances |
| Light API pool | 32 `c7i.large` workers |
| Positions API pool | 8 `c7i.large` workers |
| Transactions API pool | 16 `c7i.large` workers |
| Portfolio API pool | 32 `c7i.large` workers |
| Activity API pool | 32 `c7i.large` workers |
| Snapshot API pool | 8 `c7i.large` workers |
| Redis Cloud | OSS Cluster API enabled, 7 primaries |

Every run used randomized valid keys, a five-second warm-up, a 60-second
measured window, the production query ratios, and a fixed 30,000 writes/sec
target.

## Gzip staircase

The strict pass rule was at least 98% target achievement, no query drops or
errors, and p95 no greater than 100 ms for every query pattern.

| Level | Read target/sec | Read achieved/sec | Drops/errors | Worst read p95 | Write target/sec | Write achieved/sec | Write p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 25% | 856 | 855.32 | 0 / 0 | 69 ms | 30,000 | 29,994.84 | 10 ms | Pass |
| 50% | 1,700 | 1,699.16 | 0 / 0 | 80 ms | 30,000 | 29,994.57 | 10 ms | Pass |
| 75% | 2,556 | 2,555.09 | 0 / 0 | 95 ms | 30,000 | 29,995.34 | 9 ms | **Highest clean SLO point** |
| 100% | 3,400 | 3,398.99 | 0 / 0 | 112 ms | 30,000 | 29,995.71 | 12 ms | Throughput pass; latency fail |

## Full 100% gzip result

| Query pattern | Target/sec | Achieved/sec | p50 ms | p95 ms | p99 ms | Average payload bytes | Average wire bytes |
|---|---:|---:|---:|---:|---:|---:|---:|
| `accountById` | 170 | 169.96 | 4 | 8 | 15 | 196.31 | 403.07 |
| `securityById` | 170 | 169.96 | 5 | 9 | 21 | 8,192.00 | 469.64 |
| `securityByNo` | 170 | 169.94 | 16 | **103** | 137 | 332.35 | 607.38 |
| `positionByComposite` | 170 | 169.96 | 5 | 8 | 24 | 8,192.00 | 429.37 |
| `positionsByAccount` | 170 | 169.94 | 10 | 15 | 25 | 119,175.61 | 13,413.24 |
| `transactionById` | 170 | 169.96 | 4 | 8 | 20 | 8,192.00 | 464.90 |
| `transactionsByAccount` | 170 | 169.96 | 8 | 12 | 27 | 33,406.37 | 3,998.16 |
| `transactionsBySecurity` | 170 | 169.90 | 29 | **112** | 145 | 33,643.11 | 1,670.13 |
| `transactionsByAccountSecurity` | 170 | 169.95 | 16 | **102** | 133 | 366.62 | 696.77 |
| `accountPortfolioJoin` | 850 | 849.77 | 11 | 34 | 45 | 294,035.06 | 35,656.83 |
| `accountActivityJoin` | 850 | 849.77 | 8 | 14 | 38 | 136,899.55 | 15,948.18 |
| `accountSnapshot` | 170 | 169.92 | 13 | 41 | 51 | 430,886.94 | 51,350.30 |
| **Total** | **3,400** | **3,398.99** |  |  |  |  |  |

## Matched 100% identity-versus-gzip control

| Mode | Read achieved/sec | Worst p95 | Response MB/sec | Write achieved/sec | Write p95 |
|---|---:|---:|---:|---:|---:|
| Identity | 3,398.85 | 114 ms | 454.24 | 29,991.71 | 13 ms |
| Gzip | 3,398.99 | 112 ms | 53.72 | 29,995.71 | 12 ms |

The overall worst p95 difference is normal run-to-run variation and is not
evidence that gzip reduced latency. Per-pattern results show the expected API
CPU cost for compressing the largest documents, while the network-byte
reduction is direct and repeatable.

## Change versus the prior 100% run

| Query pattern | Prior p95 | Optimized gzip p95 | Change |
|---|---:|---:|---:|
| `positionsByAccount` | 136 ms | 15 ms | -121 ms |
| `transactionsByAccount` | 102 ms | 12 ms | -90 ms |
| `transactionsBySecurity` | 115 ms | 112 ms | -3 ms |

The snapshot-backed list reads removed the two largest query-path bottlenecks.
`transactionsBySecurity` remains an indexed cross-account search and did not
materially improve. The next optimization should focus on the three remaining
search paths that exceeded 100 ms p95 at full load:
`securityByNo`, `transactionsBySecurity`, and
`transactionsByAccountSecurity`.

## Artifacts

- [25% gzip run](../memtier-output/aws-load-runner/concurrent-18-hosts-optimized-gzip-25pct-20260723/)
- [50% gzip run](../memtier-output/aws-load-runner/concurrent-18-hosts-optimized-gzip-50pct-20260723/)
- [75% gzip run](../memtier-output/aws-load-runner/concurrent-18-hosts-optimized-gzip-75pct-20260723/)
- [100% gzip run](../memtier-output/aws-load-runner/concurrent-18-hosts-optimized-gzip-100pct-20260723/)
- [100% identity control](../memtier-output/aws-load-runner/concurrent-18-hosts-optimized-identity-100pct-20260723/)

The generated benchmark directories are intentionally gitignored and remain
in the local workspace. This report records the durable summary included in
the pull request.
