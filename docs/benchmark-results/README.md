# Benchmark Result Storage

## Storage decision

Benchmark evidence uses two storage tiers:

1. **GitHub** stores compact, reviewable material: run indexes, measured result
   tables, retrieval instructions, and SHA-256 manifests.
2. **Amazon S3** stores the raw, high-volume evidence: generator logs,
   per-process results, Redis metrics, API runtime telemetry, and CloudWatch
   exports.

The raw artifacts are packaged one archive per run. This avoids adding the
current 1.2 GB and more than 10,000 generated files to Git, while retaining
enough isolation to retrieve a single experiment. The 2026-07-28 archive
contains **73 run archives totaling 76,573,354 bytes** after compression.

## Retained S3 location

```text
s3://lpl-redis-benchmark-rdb-20260722222753244900000001/benchmark-results/raw/2026-07-28/
```

The bucket has versioning enabled, default AES-256 server-side encryption, and
all public-access blocks enabled. Its existing expiration rule applies only to
`redis-cloud/runs/`; it does not expire `benchmark-results/`.

At approximately 1.2 GB before compression and 76.6 MB after compression, the
retained evidence is small enough to favor immediate retrieval and operational
simplicity over a colder class with retrieval fees and minimum-duration
charges.

## Authoritative run index

The index deliberately distinguishes full experiments from calibration,
smoke, and failed attempts. The S3 archive contains all retained run
directories; this table identifies the evidence that should be used for
reported conclusions.

| Workload | Run directory | Offered target | Measured outcome | Interpretation |
|---|---|---:|---:|---|
| Strict mixed-load SLO | `concurrent-18-hosts-sequence-75pct-20260723T060509Z` | 2,556 reads/sec + 30,000 writes/sec | 2,555.09 reads/sec + 29,993.30 writes/sec | Highest clean mixed-load SLO point |
| Mixed-load saturation | `concurrent-18-hosts-sequence-100pct-20260723T060854Z` | 3,400 reads/sec + 30,000 writes/sec | 3,398.86 reads/sec + 29,993.88 writes/sec | Throughput passed; three read p95 objectives failed |
| 180K mixed full load | `concurrent-18-hosts-20260723T163243Z` | 180,000 reads/sec + 30,000 writes/sec | 10,136.75 reads/sec + 29,847.15 writes/sec | Admission and connection pressure dominated reads |
| 180K mixed full load with telemetry | `concurrent-18-hosts-full-load-20260723T185750Z` | 180,000 reads/sec + 30,000 writes/sec | 11,767.22 reads/sec + 29,001.74 writes/sec | Adds API, ALB, Redis timing, and Redis Cloud telemetry |
| Direct Redis, 1M provisioned ops/sec | `staircase-1m-overload-20260724T0220Z` | 180,000 reads/sec | 7,672.00 client commands/sec | Direct RESP read-only capacity test |
| Direct Redis, 2M provisioned ops/sec | `staircase-2m-overload-20260727T165726Z` | 180,000 reads/sec | 7,611.46 client commands/sec | Direct RESP read-only capacity test |
| Direct Redis, 3M provisioned ops/sec | `staircase-3m-rebuilt-overload-20260727T193250Z` | 180,000 reads/sec | 8,667.09 client commands/sec | Direct RESP read-only capacity test |
| Direct Redis, 5M provisioned ops/sec | `staircase-5m-overload-20260727T234221Z` | 180,000 reads/sec | 8,104.73 client commands/sec | Direct RESP read-only capacity test |

The direct Redis tests are not replacements for the mixed HTTP benchmark:
they contain the 12-query read mix and no trade writes.

## Retrieve and verify one run

```bash
aws s3api get-object \
  --bucket lpl-redis-benchmark-rdb-20260722222753244900000001 \
  --key benchmark-results/raw/2026-07-28/aws-load-runner/concurrent-18-hosts-full-load-20260723T185750Z.tar.gz \
  --checksum-mode ENABLED \
  /tmp/concurrent-18-hosts-full-load-20260723T185750Z.tar.gz

shasum -a 256 /tmp/concurrent-18-hosts-full-load-20260723T185750Z.tar.gz
```

Compare the result with
[`archive-manifest-2026-07-28.tsv`](archive-manifest-2026-07-28.tsv), then
extract the archive:

```bash
tar -xzf /tmp/concurrent-18-hosts-full-load-20260723T185750Z.tar.gz -C /tmp
```

## Archive future runs

With AWS credentials available:

```bash
npm run bench:archive
```

The command:

- scans the generated output for common credential patterns;
- packages each run separately;
- generates a SHA-256 manifest;
- uploads with S3 checksum validation and AES-256 encryption; and
- verifies object count, total bytes, every stored checksum, encryption, and the
  uploaded manifest.

Set `BENCHMARK_ARCHIVE_DATE` and `BENCHMARK_ARCHIVE_PREFIX` to publish under a
different date-scoped prefix. The uploader skips byte-identical existing
objects and refuses to overwrite different content under an existing key. The
command never deletes S3 objects.
