# AWS Benchmark Hosts

This Terraform stack provisions a temporary, cost-isolated benchmark tier in AWS `us-west-2`:

- Six independent Next.js API Auto Scaling Groups and ALB target groups: `light`, `positions`, `transactions`, `portfolio`, `activity`, and `snapshot`.
- Least-outstanding-request routing inside every target group.
- Nine dedicated generator hosts by default: seven query generators grouped by API cost and two disjoint trade-write generators.
- A private, encrypted, versioned S3 bucket containing the deployment bundle used by new API instances.

The generators reach the API through the ALB's private address. Keeping load generation off the API tier prevents generator CPU, sockets, and network traffic from distorting the application result.

## Query Routing

| API pool | Query patterns | Target/sec in the 180k mix |
|---|---|---:|
| `light` | `accountById`, `securityById`, `securityByNo`, `positionByComposite`, `transactionById`, `transactionsByComposite`, `transactionsByAccountSecurity` | 54,000 across the six measured patterns |
| `positions` | `positionsByAccount` | 9,000 |
| `transactions` | `transactionsByAccount`, `transactionsBySecurity` | 18,000 |
| `portfolio` | `accountPortfolioJoin` | 45,000 |
| `activity` | `accountActivityJoin` | 45,000 |
| `snapshot` | `accountSnapshot` | 9,000 |

Each process enforces a hard pool-wide admission limit. Per-pattern values default to an equal-share soft reservation and can be overridden with variables such as `API_MAX_CONCURRENT_PATTERN_ACCOUNT_BY_ID`. A pattern may borrow above its reservation while the pool still has capacity; the health endpoint reports active, reservation, borrowed, and rejected counts.

## Provision

Create an EC2 key pair first, or use an existing one. Then allow SSH from your current public IP:

```sh
npm run bench:aws-bundle
cd infra/aws-load-runner
terraform init
terraform apply \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]'
```

Build the bundle only after `.env.local` contains the live Redis endpoint. Terraform uploads that encrypted object before it creates any API launch template or Auto Scaling Group, so workers cannot launch ahead of their application. Static benchmark groups use EC2 health replacement; the runner separately applies bounded application and ALB target-health gates, preventing an application bootstrap failure from causing unbounded replacement churn.

The default desired API fleet is 64 `c7i.large` targets: 16 light, 4 positions, 8 transactions, 16 portfolio, 16 activity, and 4 snapshot. Every target uses 32 Redis connections. Per-target admission limits remain 128 for light, 32 for positions/transactions/snapshot, and 16 for portfolio/activity. These are calibration starting points, not a claim that 64 targets can meet the final load.

Change a pool independently through `api_pool_capacity`. For example:

```hcl
api_pool_capacity = {
  light = {
    min_size                        = 8
    desired_capacity                = 16
    max_size                        = 128
    redis_pool_size                 = 32
    max_concurrency                 = 128
    request_count_target_per_minute = 30000
  }
  # Define the other five required pools as well.
}
```

ALB request-count autoscaling is implemented but disabled by default. Enable it only after isolated staircase tests establish safe per-target request thresholds:

```sh
terraform apply -var='enable_api_autoscaling=true' ...
```

New scale-out targets download the Terraform-managed private bundle and start the API automatically. The runner refreshes that bundle from the current workspace, including the ignored `.env.local`, immediately before a test. The bucket blocks public access, uses server-side encryption and versioning, and is removed by `terraform destroy`.

Arm the detached cleanup watchdog before provisioning AWS. It inherits the Terraform and provider environment and invokes saved-plan teardown if its TTL expires:

```sh
AWS_LOAD_RUNNER_KEY_NAME=<your-ec2-key-pair> \
AWS_LOAD_RUNNER_SSH_CIDR=<your-public-ip>/32 \
BENCHMARK_TTL_SECONDS=14400 \
  scripts/benchmark-teardown-watchdog.sh arm
```

After normal teardown completes, disarm it with `scripts/benchmark-teardown-watchdog.sh disarm`. The runner also bounds SSH bootstrap and load-balanced API readiness waits, so a failed host ends the run instead of waiting indefinitely.

## Run The Benchmark

From the repo root:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
QUERY_GENERATOR_MODE=distributed \
  npm run bench:aws-runner
```

Optional tuning:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
QUERY_GENERATOR_MODE=distributed \
QUERY_DEFAULT_TARGET_RPS=9000 \
QUERY_JOIN_TARGET_RPS=45000 \
QUERY_TEST_TIME=60 \
QUERY_WARMUP_TIME=15 \
QUERY_REQUEST_TIMEOUT_MS=30000 \
QUERY_SOCKET_TIMEOUT_MS=30000 \
QUERY_DRAIN_TIMEOUT_MS=30000 \
QUERY_MAX_IN_FLIGHT=10000 \
QUERY_SAMPLE_POOL_SIZE=1000 \
MEMTIER_TRADE_TARGET_RPS=30000 \
LIGHT_API_MAX_CONCURRENCY=128 \
POSITIONS_API_MAX_CONCURRENCY=32 \
TRANSACTIONS_API_MAX_CONCURRENCY=32 \
PORTFOLIO_API_MAX_CONCURRENCY=16 \
ACTIVITY_API_MAX_CONCURRENCY=16 \
SNAPSHOT_API_MAX_CONCURRENCY=32 \
  npm run bench:aws-runner
```

Set `QUERY_ACCEPT_ENCODING=gzip` only if production clients request compressed responses. Results report wire bytes from successful responses separately from the uncompressed API payload bytes. Successful query responses serialize `data` once and assemble the existing JSON envelope around those bytes, preserving response content and `x-query-payload-bytes` without a second full-payload traversal in `NextResponse.json`.

Distributed concurrent mode requires six or seven query generators plus the dedicated trade generators. With the default nine hosts it uses two generators for the light pool, one for each heavyweight pool, and two for writes. Query keys and trade-write accounts remain randomized and sharded. The runner always synchronizes the workload client to every generator and installs generator dependencies in parallel, including when API reuse mode is enabled.

### Reusable seeded dataset

Keep the 2 TB-class seed outside the disposable runner lifecycle by applying
`infra/benchmark-backup` once. Then set:

```sh
AWS_LOAD_RUNNER_DATASET_MODE=auto
AWS_LOAD_RUNNER_SEED_PARTITIONS=8
```

`auto` uses the latest complete S3 manifest when it exists. On the first run it
uses eight generator hosts for deterministic, Redis-checkpointed partitions,
finalizes indexes and snapshots, then exports one RDB per Redis Cloud shard. On
subsequent runs it imports all shard files and reloads indexes/functions before
the benchmark. `seed`, `restore`, and `none` are the explicit alternatives.
The legacy `AWS_LOAD_RUNNER_SEED_INITIAL_LOAD=1` setting now maps to `auto`.

Set `AWS_LOAD_RUNNER_SEED_RESET_CHECKPOINTS=1` only to discard an incomplete
run's resume points. The retained backup stack has separate Terraform state and
is intentionally excluded from the destroy command below.

The runner records:

- Target/sec and successful achieved/sec per query.
- p50, p95, and p99 end-to-end latency.
- HTTP socket-queue, connection-setup, and time-to-first-byte percentiles.
- Successful-response bytes, error-response bytes, and API payload bytes separately.
- 429/5xx counts, request errors, drops, Redis commands, and per-worker admission snapshots.

Before sizing a fleet, run one pattern at a time against its isolated ALB pool and raise the rate until the selected latency/error SLO fails. For a direct single-target URL, leave `QUERY_STAIRCASE_TARGET_COUNT=1`; when the URL fronts a pool, set it to that pool's target count. Size each pool with:

```sh
QUERY_BASE_URL=http://<internal-alb>:3000 \
QUERY_STAIRCASE_PATTERN=accountActivityJoin \
QUERY_STAIRCASE_RATES=1000,2000,4000,8000,12000 \
npm run bench:query:staircase
```

From the workstation runner, the equivalent command executes the staircase on a dedicated generator inside the VPC:

```sh
AWS_LOAD_RUNNER_BENCHMARK=staircase \
QUERY_STAIRCASE_PATTERN=accountActivityJoin \
QUERY_STAIRCASE_RATES=1000,2000,4000,8000,12000 \
npm run bench:aws-runner
```

The AWS runner derives `QUERY_STAIRCASE_TARGET_COUNT` from the Terraform capacity of the pool serving the selected pattern. The generated `query-staircase-summary.json` includes validated aggregate capacity, per-target capacity, the 30%-headroom rate, and a suggested `request_count_target_per_minute` value.

Run all heavyweight pool staircases sequentially through the same generator with:

```sh
AWS_LOAD_RUNNER_BENCHMARK=staircaseSuite \
QUERY_GENERATOR_MODE=single-host \
QUERY_STAIRCASE_RATES=250,500,1000,2000,4000 \
LOAD_TEST_OUTPUT_DIR=memtier-output/heavy-staircase-$(date -u +%Y%m%dT%H%M%SZ) \
npm run bench:aws-runner
```

The runner passes the Terraform target count for each routed pool so the suite rollup reports aggregate and per-target rates correctly.

Run all 12 query patterns sequentially, including every member of the shared light pool, with:

```bash
AWS_LOAD_RUNNER_BENCHMARK=staircaseSuite \
QUERY_STAIRCASE_SUITE_NAME=all \
QUERY_STAIRCASE_RATES=250,500,1000,2000,4000,8000,12000 \
QUERY_WARMUP_TIME=5 \
LOAD_TEST_OUTPUT_DIR=memtier-output/query-staircase-suite-$(date -u +%Y%m%dT%H%M%SZ) \
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
npm run bench:aws-runner
```

The complete suite validates every measured payload against the last known full-payload baseline with a default tolerance of 5%. A payload mismatch stops that pattern and prevents a smaller response from being recorded as capacity.

```text
instances = ceil(target pool RPS / validated RPS per target * 1.30)
```

## Terraform Outputs

- `api_autoscaling_group_names`: ASG name by pool.
- `api_target_group_arns`: target group ARN by pool.
- `api_pool_capacity`: configured capacity and limits.
- `deployment_bundle_bucket` and `deployment_bundle_key`: private bootstrap location.
- `generator_public_dns_names`: generator management hosts.
- `generator_query_url`: private load-balanced API URL.

## Destroy

```sh
cd infra/aws-load-runner
terraform destroy \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]'
```

The API groups, generators, ALB, deployment bucket and object versions, IAM resources, and security groups remain billable until destruction completes. The separate `infra/benchmark-backup` bucket and its RDB objects remain available for later runs.
