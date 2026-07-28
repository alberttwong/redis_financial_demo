# Direct Redis Capacity Results

Date range: 2026-07-24 through 2026-07-28 UTC

## Capacity comparison

All four experiments offered the same 180,000 read requests/sec query mix
directly over RESP from 32 generator instances. They did not include the HTTP
API tier or trade writes.

| Provisioned capacity | Shards | Client commands/sec | FT.SEARCH/sec | Redis peak ops/sec | Redis peak egress GB/sec | Sizing constraint |
|---:|---:|---:|---:|---:|---:|---|
| 1,000,000 ops/sec | 100 | 7,672.00 | 847.79 | 104,984.89 | 1.126 | Storage floor |
| 2,000,000 ops/sec | 100 | 7,611.46 | 864.79 | 105,035.22 | 1.090 | Storage floor |
| 3,000,000 ops/sec | 120 | 8,667.09 | 891.91 | 131,052.33 | 1.278 | Throughput floor |
| 5,000,000 ops/sec | 200 | 8,104.73 | 885.66 | 210,008.00 | 1.366 | Throughput floor |

The internal sizing unit was the Redis Cloud Large bucket at 25 GB and 25,000
ops/sec per shard. More provisioned operations did not produce proportional
query throughput. The workload remained limited by query execution,
large-result transfer, and client-side completion rather than the subscription
operations ceiling.

## AWS generator network

CloudWatch `NetworkIn` is the response traffic received by the generator
instances; `NetworkOut` is primarily requests and acknowledgments.

| Capacity | Peak NetworkIn GB/sec | Peak NetworkIn Gbit/sec | Peak NetworkOut MB/sec |
|---:|---:|---:|---:|
| 1M | 0.920 | 7.36 | 2.52 |
| 2M | 0.893 | 7.14 | 2.26 |
| 3M | 1.126 | 9.01 | 3.13 |
| 5M | 0.910 | 7.28 | 2.64 |

## AWS generator packets

Each experiment used a five-minute CloudWatch window across 32 instances.
Average, minimum, and maximum values are per-instance one-minute samples; sum
is the fleet total over the window.

| Capacity | Metric | Sum | Average | Minimum | Maximum |
|---:|---|---:|---:|---:|---:|
| 1M | NetworkPacketsIn | 55,191,655 | 374,110.37 | 4 | 1,553,132 |
| 1M | NetworkPacketsOut | 1,826,810 | 12,385.96 | 5 | 47,974 |
| 2M | NetworkPacketsIn | 55,614,198 | 381,824.43 | 43 | 1,505,377 |
| 2M | NetworkPacketsOut | 2,000,678 | 13,708.09 | 39 | 48,928 |
| 3M | NetworkPacketsIn | 54,002,070 | 337,512.94 | 4 | 1,757,337 |
| 3M | NetworkPacketsOut | 2,052,403 | 12,827.52 | 5 | 69,109 |
| 5M | NetworkPacketsIn | 65,451,742 | 409,073.39 | 4 | 1,766,449 |
| 5M | NetworkPacketsOut | 3,087,849 | 19,299.06 | 5 | 84,234 |

## Evidence

The checksummed raw archives and CloudWatch per-instance CSV are stored under:

```text
s3://lpl-redis-benchmark-rdb-20260722222753244900000001/benchmark-results/raw/2026-07-28-complete/
```

See [Benchmark Result Storage](README.md) for the authoritative run mapping and
retrieval procedure.
