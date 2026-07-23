# Full 180,000 Read/sec Load-Test Results

Date: 2026-07-23 UTC

## Executive result

The synchronized full-load benchmark ran against the retained approximately
2 TB dataset with a target of **180,000 HTTP reads/sec plus 30,000 trade
writes/sec**.

- Reads achieved **10,136.75/sec**, or **5.63%** of target.
- Writes achieved **29,847.15/sec**, or **99.49%** of target, with zero write
  errors.
- Combined client-visible throughput was **39,983.90 operations/sec** against
  the 210,000 operations/sec combined target.
- Read admission limits returned 7,544,659 HTTP 429 responses. The generators
  also dropped 2,296,563 unscheduled requests and recorded 345,915 30-second
  wall-clock timeouts.
- Redis reported zero blocked clients and zero rejected connections before and
  after the run.

The write target was sustained, but the read target was not. At this overload
level, API admission and connection pressure dominated the lightweight point
reads, while several dedicated heavyweight pools continued to return successful
responses at lower rates.

## Tested architecture

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
| Total AWS instances | 146 `c7i.large` instances |
| Redis Cloud | Redis 8.6.2, OSS Cluster API enabled, 7 primaries |

The query workload used randomized valid keys, gzip response encoding, a
15-second warm-up, a 60-second measured window, a 30-second request deadline,
and the production query ratios. The two join patterns each received five
times the target of each standard pattern. Two dedicated write generators
shared the 30,000 writes/sec target.

## Query results

Latencies are client-observed completion latencies and include fast HTTP 429
responses as well as successful responses. They must not be read as
success-only service latency at this overload level. A value of 30,001 ms is
the histogram sentinel for a 30-second request timeout.

| Query pattern | Target/sec | Achieved/sec | p50 ms | p95 ms | p99 ms | Average payload bytes |
|---|---:|---:|---:|---:|---:|---:|
| `accountById` | 9,000 | 359.23 | 130 | 30,001 | 30,001 | 196.30 |
| `securityById` | 9,000 | 351.48 | 130 | 30,001 | 30,001 | 8,192.00 |
| `securityByNo` | 9,000 | 314.91 | 129 | 30,001 | 30,001 | 332.63 |
| `positionByComposite` | 9,000 | 401.27 | 124 | 30,001 | 30,001 | 8,192.01 |
| `positionsByAccount` | 9,000 | 283.85 | 54 | 116 | 266 | 119,169.90 |
| `transactionById` | 9,000 | 464.31 | 120 | 30,001 | 30,001 | 8,192.00 |
| `transactionsByAccount` | 9,000 | 383.65 | 6 | 31 | 136 | 33,404.32 |
| `transactionsBySecurity` | 9,000 | 253.24 | 6 | 35 | 759 | 35,303.52 |
| `transactionsByAccountSecurity` | 9,000 | 422.00 | 119 | 30,001 | 30,001 | 716.62 |
| `accountPortfolioJoin` | 45,000 | 1,827.00 | 33 | 188 | 30,001 | 294,023.99 |
| `accountActivityJoin` | 45,000 | 4,923.80 | 28 | 185 | 30,001 | 136,900.88 |
| `accountSnapshot` | 9,000 | 152.01 | 67 | 118 | 466 | 430,898.05 |
| **Total** | **180,000** | **10,136.75** |  |  |  |  |

The 12 patterns produced 608,206 successful responses during the measured
window. Successful gzip responses transferred **150.99 MB/sec** over HTTP;
their corresponding uncompressed API payloads totaled **1,280.56 MB/sec**.

## Trade-write result

| Pattern | Target/sec | Achieved/sec | p50 ms | p95 ms | p99 ms | Dropped | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| `tradeWrites` | 30,000 | 29,847.15 | 33 | 356 | 635 | 4,203 | 0 |

The two generators inserted 1,795,797 unique transactions in total and
1,790,829 during the measured window. They used 1,000 distinct account slots
and 1,000 distinct position keys.

## Redis observations

The client-visible top-level Redis command rate was approximately
**39,983.90 commands/sec** during the measurement window: one Redis command per
successful read plus one `FCALL` per successful trade write. This is not the
same as Redis internal work performed inside each function.

Across the broader 161.929-second before/after capture interval, Redis
`total_commands_processed` increased by 2,540,133, network input increased by
9,768,512,134 bytes, and network output increased by 215,278,781,152 bytes.
That interval includes startup, warm-up, the measured workload, request drain,
and metrics collection, so those byte deltas are not 60-second rates.

## Validity note

An immediately preceding attempt was excluded because both write generators
started before restored search results were fully visible and exited with an
empty account sample pool. After the restored dataset stabilized, both write
hosts independently verified all 6,600 accounts and a complete 1,000-account
sample. This recorded run then produced complete read and write artifacts.

## Primary artifacts

The generated benchmark directory is intentionally gitignored. The retained
local evidence is:

- Query summary: `memtier-output/aws-load-runner/concurrent-18-hosts-20260723T163243Z/concurrent-query-summary.md`
- Query summary JSON: `memtier-output/aws-load-runner/concurrent-18-hosts-20260723T163243Z/concurrent-query-summary.json`
- Trade-write aggregate: `memtier-output/aws-load-runner/concurrent-18-hosts-20260723T163243Z/trade-writes-aggregate.json`
- Redis metrics before: `memtier-output/aws-load-runner/concurrent-18-hosts-20260723T163243Z/redis-metrics-before-concurrent.json`
- Redis metrics after: `memtier-output/aws-load-runner/concurrent-18-hosts-20260723T163243Z/redis-metrics-after-concurrent.json`

The AWS and Redis Cloud resources remain provisioned and billable. The retained
S3 RDB backup was not modified or deleted.
