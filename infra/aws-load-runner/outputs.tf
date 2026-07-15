output "instance_id" {
  description = "Legacy alias for the query API instance ID."
  value       = aws_instance.api[0].id
}

output "public_ip" {
  description = "Legacy alias for the query API public IP."
  value       = aws_instance.api[0].public_ip
}

output "public_dns" {
  description = "Legacy alias for the query API public DNS name."
  value       = aws_instance.api[0].public_dns
}

output "api_instance_id" {
  description = "Legacy alias for the first query API instance ID."
  value       = aws_instance.api[0].id
}

output "api_public_ip" {
  description = "Legacy alias for the first query API public IP."
  value       = aws_instance.api[0].public_ip
}

output "api_public_dns" {
  description = "Legacy alias for the first query API public DNS name."
  value       = aws_instance.api[0].public_dns
}

output "api_private_ip" {
  description = "Legacy alias for the first query API private IP."
  value       = aws_instance.api[0].private_ip
}

output "api_instance_ids" {
  description = "EC2 instance IDs for all query API workers."
  value       = aws_instance.api[*].id
}

output "api_public_dns_names" {
  description = "Public DNS names used to sync and manage all query API workers."
  value       = aws_instance.api[*].public_dns
}

output "api_private_ips" {
  description = "Private IPs for all query API workers."
  value       = aws_instance.api[*].private_ip
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
  description = "Commands to check bootstrap status on the benchmark hosts."
  value = {
    api        = [for instance in aws_instance.api : "ssh ec2-user@${instance.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"]
    generator  = "ssh ec2-user@${aws_instance.generator[0].public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"
    generators = [for instance in aws_instance.generator : "ssh ec2-user@${instance.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"]
  }
}

output "web_url" {
  description = "Ad hoc public query workbench URL when web_ingress_cidr_blocks allows access."
  value       = "http://${aws_instance.api[0].public_dns}:${var.web_port}"
}

output "generator_query_url" {
  description = "Private load-balanced query API URL used by the load-generator hosts."
  value       = "http://${aws_lb.api.dns_name}:${var.web_port}"
}

output "api_load_balancer_dns" {
  description = "Internal application load balancer DNS name for the API tier."
  value       = aws_lb.api.dns_name
}

output "api_target_group_arn" {
  description = "Target group ARN used to inspect API worker health and load balancer metrics."
  value       = aws_lb_target_group.api.arn
}
