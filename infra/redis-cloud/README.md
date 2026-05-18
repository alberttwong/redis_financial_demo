# Redis Cloud Terraform

This Terraform stack provisions the Redis Cloud database for the financial query demo.

Defaults:

- Redis Cloud Essentials paid
- AWS `us-west-2`
- Subscription: `lpl-redis-demo`
- Database: `lpl-query-patterns`
- Default Redis Cloud account payment method
- TLS enabled
- `noeviction`

## Prerequisites

Set Redis Cloud API credentials:

```sh
export REDISCLOUD_ACCESS_KEY=...
export REDISCLOUD_SECRET_KEY=...
```

## Provision

```sh
terraform init
terraform plan
terraform apply
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
