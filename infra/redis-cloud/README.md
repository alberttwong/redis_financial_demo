# Redis Cloud Terraform

This Terraform stack provisions the Redis Cloud database for the financial query demo.

Defaults:

- Redis Cloud Pro/Flexible
- AWS `us-west-2`
- Subscription: `lpl-redis-demo`
- Database: `lpl-query-patterns`
- Redis version: `8.6`
- Dataset size: 20 GB
- Throughput sizing: 1,000,000 operations per second
- Default Redis Cloud account payment method
- TLS enabled
- `noeviction`
- Redis OSS Cluster API disabled unless explicitly enabled
- Optional Terraform-managed AWS VPC peering and routes to the private Redis
  Cloud network

Essentials is still available for smaller demos by setting:

```sh
terraform plan -var='subscription_type=essentials'
```

Switching an existing Terraform-managed Essentials deployment to the default Pro/Flexible resource family will create Pro/Flexible resources and remove the Essentials resources from the same state. Export or reseed demo data before applying that change.

## Prerequisites

Store Redis Cloud API credentials in 1Password, or export them in your shell.
The wrapper script loads credentials from 1Password first and falls back to
exported environment variables.

```sh
op item create \
  --vault Redis \
  --category "API Credential" \
  --title "LPL Redis Cloud Terraform" \
  REDISCLOUD_ACCESS_KEY[password]=... \
  REDISCLOUD_SECRET_KEY[password]=...

export REDISCLOUD_ACCESS_KEY=...
export REDISCLOUD_SECRET_KEY=...
```

To use a different 1Password location, set `REDISCLOUD_OP_VAULT` and
`REDISCLOUD_OP_ITEM`. To skip 1Password lookup, set
`REDISCLOUD_USE_1PASSWORD=0`.

## Provision

```sh
terraform init
./terraform-with-creds.sh plan
./terraform-with-creds.sh apply
```

For a Redis Cloud Pro database that advertises its managed shard topology to a
cluster-aware client, plan and apply with:

```sh
./terraform-with-creds.sh plan \
  -var='support_oss_cluster_api=true' \
  -var='external_endpoint_for_oss_cluster_api=true'
./terraform-with-creds.sh apply
```

The external endpoint is required when the benchmark clients run outside the
Redis Cloud managed VPC. OSS Cluster API requires the Pro subscription path.

To let AWS benchmark hosts reach Redis Cloud private endpoints, including the
subscription Prometheus endpoint on port `8070`, enable the managed peering:

```sh
./terraform-with-creds.sh plan \
  -var='enable_aws_vpc_peering=true'
./terraform-with-creds.sh apply
```

By default, the stack peers the default AWS VPC in `var.region`. Set
`aws_vpc_id` to select a different application VPC. Redis Cloud initiates the
request; Terraform accepts it in AWS and adds a route for
`networking_deployment_cidr` to every route table in the selected VPC.

To enable scheduled Redis Cloud backups in the same persistent S3 bucket used
by the benchmark restore workflow:

```sh
backup_path="$(terraform -chdir=../benchmark-backup output -raw redis_cloud_backup_path)"
./terraform-with-creds.sh apply \
  -var="backup_s3_path=${backup_path}" \
  -var='backup_interval=every-24-hours' \
  -var='backup_time_utc=06:00'
```

The bucket must be applied first. `scripts/redis-cloud-rdb.sh backup` creates a
dated on-demand backup and a stable manifest; `restore` imports all shard files
listed by that manifest and deliberately requires confirmation because Redis
Cloud import overwrites the destination database.

Terraform creates paid Redis Cloud resources. Use `terraform destroy` when the demo database is no longer needed.

## App Env

After apply:

```sh
terraform output -raw redis_url
```

For a conventional Redis Cloud endpoint, use `redis_url` as `REDIS_URL`. For an
OSS Cluster API database, use `redis_cluster_root_nodes` as
`REDIS_CLUSTER_ROOT_NODES`, plus the `redis_password` and `redis_tls` outputs.

Run from the repo root:

```sh
npm run redis:check
```

The check script verifies Redis version, JSON commands, and Redis Query Engine index creation.
