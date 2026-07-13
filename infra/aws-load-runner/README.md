# AWS Load Runner

This Terraform stack provisions a temporary EC2 benchmark host in AWS `us-west-2` so `memtier_benchmark` runs close to the Redis Cloud database.

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

The default instance type is `c7i.4xlarge` so one runner can keep enough client-side work in flight for the 180,000 ops/sec profile.

## Run The Benchmark

From the repo root:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
  npm run bench:aws-runner
```

Optional benchmark tuning:

```sh
AWS_LOAD_RUNNER_KEY_PATH=~/.ssh/<your-key>.pem \
MEMTIER_THREADS=8 \
MEMTIER_CLIENTS=100 \
MEMTIER_PIPELINE=64 \
MEMTIER_POSITIONS_RATE_PER_CONNECTION=188 \
MEMTIER_TRADE_RATE_PER_CONNECTION=38 \
  npm run bench:aws-runner
```

The helper runs:

1. `npm ci`
2. `npm run bench:prepare`
3. `npm run bench:aws-web`
4. `npm run bench:concurrent`

`bench:aws-web` builds and starts the Next.js query workbench on port `3000` for ad hoc browser queries. `bench:concurrent` starts `bench:positions-by-account` and `bench:trade-writes` at the same time, so the downloaded positions-by-account and trade-write result files represent the same load-test window. Defaults target about `150,000` positionsByAccount reads/sec and `30,000` trade writes/sec with `MEMTIER_THREADS=8`, `MEMTIER_CLIENTS=100`, and `MEMTIER_PIPELINE=64`.

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
