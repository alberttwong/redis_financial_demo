# AWS Benchmark Hosts

This Terraform stack provisions a temporary horizontally scaled benchmark tier in AWS `us-west-2`:

- 16 one-process Next.js query API workers spread across the default VPC's availability zones.
- An internal Application Load Balancer with health checks for every API worker.
- A dedicated load-generator host for the 12 HTTP query runners and distributed atomic trade writer.

The generator reaches the API through the ALB's private address. Keeping load generation off the API tier prevents scheduler, CPU, memory, and network contention from distorting the application result.

The stack does not receive or store `REDIS_URL`. `scripts/aws-load-runner-run.sh` copies the ignored local `.env.local` to the API workers and generator over SSH at run time and sets mode `0600`.

## Provision

Create an EC2 key pair first, or use an existing one. Then allow SSH from your current public IP:

```sh
cd infra/aws-load-runner
terraform init
terraform apply \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]' \
  -var='web_ingress_cidr_blocks=["<your-public-ip>/32"]'
```

API workers default to 16 `c7i.large` instances and the generator defaults to one `c7i.4xlarge`. Override `api_instance_count`, `instance_type`, or `generator_instance_type` to change the tier. These resources and the ALB remain billable until destroyed. Actual achieved throughput depends on response size, query latency, Redis Cloud capacity, and generator capacity.

The stack applies `owner=albert_wong` by default because the target AWS account automatically terminates EC2 instances that do not carry an `owner` tag. Override `tags.owner` when deploying for a different account owner.

## Run The Benchmark

From the repo root:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
  npm run bench:aws-runner
```

Optional benchmark tuning:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
QUERY_DEFAULT_TARGET_RPS=10000 \
QUERY_JOIN_TARGET_RPS=50000 \
QUERY_TEST_TIME=60 \
QUERY_SAMPLE_POOL_SIZE=1000 \
QUERY_RANDOM_SEED=20260714 \
MEMTIER_TRADE_TARGET_RPS=30000 \
TRADE_SAMPLE_POOL_SIZE=1000 \
TRADE_RANDOM_SEED=20260714 \
  npm run bench:aws-runner
```

To run only the randomized 10,000 req/sec point-read scale gate:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
AWS_LOAD_RUNNER_BENCHMARK=accountById \
QUERY_DEFAULT_TARGET_RPS=10000 \
QUERY_TEST_TIME=60 \
QUERY_MAX_IN_FLIGHT=10000 \
QUERY_SAMPLE_POOL_SIZE=1000 \
API_REDIS_POOL_SIZE=16 \
  npm run bench:aws-runner
```

To divide that same target across four synchronized Node processes on the dedicated generator host:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
AWS_LOAD_RUNNER_BENCHMARK=accountById \
QUERY_GENERATOR_PROCESSES=4 \
QUERY_DEFAULT_TARGET_RPS=10000 \
QUERY_TEST_TIME=60 \
QUERY_MAX_IN_FLIGHT=10000 \
QUERY_MAX_SOCKETS=10000 \
QUERY_SAMPLE_POOL_SIZE=1000 \
API_REDIS_POOL_SIZE=16 \
  npm run bench:aws-runner
```

The sharded runner divides the aggregate request rate, in-flight ceiling, and HTTP socket budget across the processes, gives each process a distinct deterministic random seed, and releases all processes through one epoch-time barrier. It merges the per-process latency histograms so the aggregate percentiles remain exact. Each run writes per-process artifacts plus `query-account-by-id-aggregate.json` under a timestamped `memtier-output/query-account-by-id-<count>-shards-*` directory.

The helper:

1. Syncs the repository and `.env.local` to the generator and every API worker.
2. Installs dependencies and starts one production Next.js process per API instance with a bounded Redis pool.
3. Waits until every registered ALB target is healthy.
4. Captures Redis metrics before and after either `accountById` or the default `bench:concurrent` run.
5. Downloads generator artifacts, per-worker runtime metrics, and API logs even when a target run reports errors.

Query requests select new valid keys from Redis-backed sample pools. Trade writes select many existing positions while keeping each transaction and position in the same Redis hash slot.

Terraform outputs `web_url` for the optional public workbench, `generator_query_url` for the private load-balanced route, and `api_target_group_arn` for target-health and CloudWatch inspection.

## Destroy

```sh
cd infra/aws-load-runner
terraform destroy \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]' \
  -var='web_ingress_cidr_blocks=["<your-public-ip>/32"]'
```
