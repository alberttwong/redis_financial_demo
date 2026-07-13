# AWS Load Runner

This Terraform stack provisions a temporary EC2 benchmark host in AWS `us-west-2` so the query API, HTTP load generators, and `memtier_benchmark` trade writer run close to the Redis Cloud database.

The stack does not receive or store `REDIS_URL`. Use `scripts/aws-load-runner-run.sh` after provisioning; it copies your local `.env.local` to the host over SSH at run time.

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

The default instance type is `c7i.4xlarge` so one runner can keep the query API and load generators active for the 230,000 ops/sec target profile. Actual achieved throughput depends on response size, query latency, and Redis Cloud capacity.

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
MEMTIER_TRADE_TARGET_RPS=30000 \
  npm run bench:aws-runner
```

The helper runs:

1. `npm ci`
2. `npm run bench:aws-web`
3. `npm run bench:concurrent`

`bench:aws-web` builds and starts the Next.js query workbench on port `3000`. `bench:concurrent` runs the 12 query-pattern load tests against that API and runs atomic trade writes during the same window. Defaults target two joins at `50,000` reads/sec each, ten other queries at `10,000` reads/sec each, and `30,000` new transaction writes/sec.

It copies `memtier-output/` back to the local repo when finished and redacts the memtier JSON auth field on the remote host before download.

Terraform outputs `web_url`; it is reachable only from CIDRs passed through `web_ingress_cidr_blocks`.

## Destroy

```sh
cd infra/aws-load-runner
terraform destroy \
  -var='key_name=<your-ec2-key-pair>' \
  -var='ssh_ingress_cidr_blocks=["<your-public-ip>/32"]' \
  -var='web_ingress_cidr_blocks=["<your-public-ip>/32"]'
```
