# AWS Direct Redis Load Generators

This Terraform stack provisions only direct RESP load generators. It does not
create an API tier, an ALB, or API admission controls.

The benchmark configuration uses 32 `r8i.2xlarge` generators. AWS advertises
up to 15 Gbps of network bandwidth for this size in `us-west-2`. Four Node
processes per host share the fixed 12-pattern query mix and connect directly to
the Redis Cloud OSS Cluster API.

For the production-ratio read/write test, the generators are isolated by
workload rather than sharing the mix. The default allocation uses 29 dedicated
read hosts and three write hosts:

- one host for each lightweight point/search pattern;
- two hosts each for positions, transactions by account, and transactions by
  security;
- eight portfolio hosts, five activity hosts, and four full-snapshot hosts;
- three disjoint trade-write shards.

The read generators execute the existing query functions directly through the
cluster-aware Redis client. Writers issue unique `FCALL apply_transaction`
operations and sample immediate transaction, position, and account-snapshot
reads for correctness without adding those validation reads to write latency.

Every generator publishes the EC2 ENA inbound/outbound bandwidth,
packet-rate, connection-tracking, and link-local allowance counters through the
CloudWatch Agent. The staircase output includes raw CloudWatch data plus
`ec2-network-allowance-metrics.json` and Markdown with cumulative-counter
increases for each instance and fleet sum/average/minimum/maximum. Missing
telemetry is reported explicitly so a zero is not mistaken for an absent
metric.

```bash
terraform -chdir=infra/aws-direct-redis-runner init
terraform -chdir=infra/aws-direct-redis-runner apply -var-file=benchmark.tfvars
```

Run the synchronized 180,000-read/sec plus 30,000-write/sec workload with:

```bash
AWS_DIRECT_REDIS_KEY_PATH=~/.ssh/albert.wong.redis.aws-nonprod.pem \
npm run bench:redis-direct:full
```

The result contains per-pattern target/achieved throughput, p50/p95/p99
logical and Redis latency, payload rates, write p99.9, sampled correctness,
Redis Cloud metrics, EC2 network bytes/packets, and ENA allowance counters.
Use `DIRECT_FULL_READ_TARGET_RPS`, `DIRECT_FULL_WRITE_TARGET_RPS`, and
`DIRECT_FULL_TEST_TIME` for a lower-rate gate or longer soak without changing
the workload ratios.

Collection is enabled by default. It can be disabled or its publication wait
adjusted when needed:

```text
AWS_DIRECT_REDIS_COLLECT_NETWORK_ALLOWANCE_METRICS=1
AWS_DIRECT_REDIS_CLOUDWATCH_METRIC_DELAY_SECONDS=60
```

The stack is ephemeral and has its own Terraform state so it can be destroyed
without modifying the retained RDB bucket:

```bash
terraform -chdir=infra/aws-direct-redis-runner destroy -var-file=benchmark.tfvars
```
