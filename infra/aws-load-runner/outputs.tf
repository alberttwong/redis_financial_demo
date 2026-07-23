output "api_autoscaling_group_names" {
  description = "Auto Scaling Group name for each cost-isolated API pool."
  value       = { for pool, group in aws_autoscaling_group.api : pool => group.name }
}

output "redis_oss_cluster_root_nodes" {
  description = "Private Redis OSS Cluster root nodes used by cluster-aware clients."
  value       = local.redis_cluster_root_nodes
}

output "redis_oss_cluster_password" {
  description = "Temporary Redis OSS Cluster password."
  value       = var.enable_redis_oss_cluster ? random_password.redis_oss[0].result : ""
  sensitive   = true
}

output "redis_oss_cluster_instance_ids" {
  description = "All temporary Redis OSS Cluster EC2 instance IDs."
  value       = aws_instance.redis_oss[*].id
}

output "redis_oss_cluster_private_ips" {
  description = "All temporary Redis OSS Cluster private IPs."
  value       = aws_instance.redis_oss[*].private_ip
}

output "redis_oss_cluster_public_dns_names" {
  description = "Management DNS names for temporary Redis OSS Cluster nodes."
  value       = aws_instance.redis_oss[*].public_dns
}

output "api_target_group_arns" {
  description = "ALB target group ARN for each cost-isolated API pool."
  value       = { for pool, group in aws_lb_target_group.api : pool => group.arn }
}

output "api_pool_capacity" {
  description = "Configured min, desired, max, Redis pool, concurrency, and request-target values for each API pool."
  value       = var.api_pool_capacity
}

output "deployment_bundle_bucket" {
  description = "Private encrypted S3 bucket used to bootstrap API scale-out instances."
  value       = aws_s3_bucket.deployment.id
}

output "deployment_bundle_key" {
  description = "S3 object key expected by API scale-out instances."
  value       = var.deployment_bundle_key
}

output "deployment_bundle_etag" {
  description = "ETag of the bootstrap bundle Terraform uploaded before creating API launch templates."
  value       = aws_s3_object.deployment_bundle.etag
}

output "generator_instance_id" {
  description = "Legacy alias for the first load-generator instance ID."
  value       = aws_instance.generator[0].id
}

output "generator_public_ip" {
  description = "Legacy alias for the first load-generator public IP."
  value       = aws_instance.generator[0].public_ip
}

output "generator_public_dns" {
  description = "Legacy alias for the first load-generator public DNS name."
  value       = aws_instance.generator[0].public_dns
}

output "generator_private_ip" {
  description = "Legacy alias for the first load-generator private IP."
  value       = aws_instance.generator[0].private_ip
}

output "generator_instance_ids" {
  description = "EC2 instance IDs for all dedicated load-generator hosts."
  value       = aws_instance.generator[*].id
}

output "generator_public_dns_names" {
  description = "Public DNS names used to sync and manage all load-generator hosts."
  value       = aws_instance.generator[*].public_dns
}

output "generator_private_ips" {
  description = "Private IPs for all dedicated load-generator hosts."
  value       = aws_instance.generator[*].private_ip
}

output "ssh_user" {
  description = "Default SSH user for Amazon Linux 2023."
  value       = "ec2-user"
}

output "ready_check" {
  description = "Commands to check bootstrap status on benchmark hosts."
  value = {
    api_pools = {
      for pool, group in aws_autoscaling_group.api : pool => "aws autoscaling describe-auto-scaling-groups --region ${var.aws_region} --auto-scaling-group-names ${group.name}"
    }
    generators = [
      for instance in aws_instance.generator :
      "ssh ec2-user@${instance.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"
    ]
  }
}

output "generator_query_url" {
  description = "Private load-balanced query API URL used by load-generator hosts."
  value       = "http://${aws_lb.api.dns_name}:${var.web_port}"
}

output "api_load_balancer_dns" {
  description = "Internal application load balancer DNS name for the API tier."
  value       = aws_lb.api.dns_name
}

output "api_load_balancer_arn_suffix" {
  description = "CloudWatch dimension value for the internal API application load balancer."
  value       = aws_lb.api.arn_suffix
}

output "api_target_group_arn" {
  description = "Legacy alias for the light-query API target group ARN."
  value       = aws_lb_target_group.api["light"].arn
}

output "light_api_target_group_arn" {
  description = "Legacy alias for the light-query API target group ARN."
  value       = aws_lb_target_group.api["light"].arn
}
