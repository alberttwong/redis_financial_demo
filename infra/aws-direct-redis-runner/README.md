# AWS Direct Redis Load Generators

This Terraform stack provisions only direct RESP load generators. It does not
create an API tier, an ALB, or API admission controls.

The benchmark configuration uses 32 `c7i.2xlarge` generators. Four Node
processes per host share the fixed 12-pattern query mix and connect directly to
the Redis Cloud OSS Cluster API.

```bash
terraform -chdir=infra/aws-direct-redis-runner init
terraform -chdir=infra/aws-direct-redis-runner apply -var-file=benchmark.tfvars
```

The stack is ephemeral and has its own Terraform state so it can be destroyed
without modifying the retained RDB bucket:

```bash
terraform -chdir=infra/aws-direct-redis-runner destroy -var-file=benchmark.tfvars
```
