# AWS Benchmark Hosts

This Terraform stack provisions two temporary EC2 hosts in AWS `us-west-2`:

- A dedicated Next.js query API host.
- A dedicated load-generator host for the 12 HTTP query runners and distributed atomic trade writer.

The generator reaches the API on its private VPC address. Keeping load generation off the API host prevents scheduler, CPU, memory, and network contention from distorting the application result.

The stack does not receive or store `REDIS_URL`. `scripts/aws-load-runner-run.sh` copies the ignored local `.env.local` to both hosts over SSH at run time and sets mode `0600`.

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

Both roles default to `c7i.4xlarge`. Override `instance_type` for the API host or `generator_instance_type` for the load-generator host. Actual achieved throughput depends on response size, query latency, Redis Cloud capacity, and the number of application and generator hosts.

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

The helper:

1. Syncs the repository and `.env.local` to both hosts.
2. Installs dependencies and starts the production Next.js API on the API host.
3. Runs `bench:concurrent` on the generator host against the API private IP.
4. Downloads generator artifacts and the API web log even when a target run reports errors.

Query requests select new valid keys from Redis-backed sample pools. Trade writes select many existing positions while keeping each transaction and position in the same Redis hash slot.

Terraform outputs `web_url` for the optional public workbench and `generator_query_url` for the private generator-to-API route.

## Destroy

```sh
cd infra/aws-load-runner
terraform destroy \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]' \
  -var='web_ingress_cidr_blocks=["<your-public-ip>/32"]'
```
