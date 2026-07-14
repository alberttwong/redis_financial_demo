output "instance_id" {
  description = "Legacy alias for the query API instance ID."
  value       = aws_instance.api.id
}

output "public_ip" {
  description = "Legacy alias for the query API public IP."
  value       = aws_instance.api.public_ip
}

output "public_dns" {
  description = "Legacy alias for the query API public DNS name."
  value       = aws_instance.api.public_dns
}

output "api_instance_id" {
  description = "EC2 instance ID for the query API host."
  value       = aws_instance.api.id
}

output "api_public_ip" {
  description = "Public IP used to sync and manage the query API host."
  value       = aws_instance.api.public_ip
}

output "api_public_dns" {
  description = "Public DNS name used to sync and manage the query API host."
  value       = aws_instance.api.public_dns
}

output "api_private_ip" {
  description = "Private IP used by the load generator to reach the query API."
  value       = aws_instance.api.private_ip
}

output "generator_instance_id" {
  description = "EC2 instance ID for the load-generator host."
  value       = aws_instance.generator.id
}

output "generator_public_ip" {
  description = "Public IP used to sync and manage the load-generator host."
  value       = aws_instance.generator.public_ip
}

output "generator_public_dns" {
  description = "Public DNS name used to sync and manage the load-generator host."
  value       = aws_instance.generator.public_dns
}

output "generator_private_ip" {
  description = "Private IP for the load-generator host."
  value       = aws_instance.generator.private_ip
}

output "ssh_user" {
  description = "Default SSH user for Amazon Linux 2023."
  value       = "ec2-user"
}

output "ready_check" {
  description = "Commands to check bootstrap status on both benchmark hosts."
  value = {
    api       = "ssh ec2-user@${aws_instance.api.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"
    generator = "ssh ec2-user@${aws_instance.generator.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"
  }
}

output "web_url" {
  description = "Ad hoc public query workbench URL when web_ingress_cidr_blocks allows access."
  value       = "http://${aws_instance.api.public_dns}:${var.web_port}"
}

output "generator_query_url" {
  description = "Private query API URL used by the load-generator host."
  value       = "http://${aws_instance.api.private_ip}:${var.web_port}"
}
