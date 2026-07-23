# Persistent benchmark dataset backup

This stack owns the S3 bucket used for Redis Cloud RDB backups. It is deliberately
separate from `infra/aws-load-runner` and `infra/redis-cloud`, and `force_destroy`
defaults to `false`, so benchmark teardown leaves the reusable seeded dataset intact.

```bash
terraform -chdir=infra/benchmark-backup init
terraform -chdir=infra/benchmark-backup apply
terraform -chdir=infra/benchmark-backup output
```

The bucket policy grants the Redis Cloud AWS account only the object operations
required for backup and import. Seed RDBs are retained by default so the stable
`redis-cloud/latest.json` manifest cannot age into a broken pointer. Set
`backup_retention_days` only when automatic expiration is preferred; account for
the recurring seed cadence before choosing it. The manifest is versioned.

Redis Cloud validates AWS destinations at the bucket boundary, so the configured
backup path is `s3://bucket` rather than a nested prefix. Redis Cloud writes the
shard RDBs at that destination; run manifests remain under `redis-cloud/runs/`.

Do not destroy this stack as part of a benchmark run. To remove it intentionally,
delete retained objects and versions first, then explicitly opt into `force_destroy`.
