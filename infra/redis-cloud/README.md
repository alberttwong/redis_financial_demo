# Redis Cloud Terraform

This Terraform stack provisions the Redis Cloud database for the financial query demo.

Defaults:

- Redis Cloud Pro/Flexible
- AWS `us-west-2`
- Subscription: `lpl-redis-demo`
- Database: `lpl-query-patterns`
- Redis version: `8.4`
- Dataset size: 20 GB
- Throughput sizing: 300,000 operations per second
- Default Redis Cloud account payment method
- TLS enabled
- `noeviction`

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

Terraform creates paid Redis Cloud resources. Use `terraform destroy` when the demo database is no longer needed.

## App Env

After apply:

```sh
terraform output -raw redis_url
```

Use that value as `REDIS_URL` in `.env.local`, and set `REDIS_TLS` to the `redis_tls` output.

Run from the repo root:

```sh
npm run redis:check
```

The check script verifies Redis version, JSON commands, and Redis Query Engine index creation.
