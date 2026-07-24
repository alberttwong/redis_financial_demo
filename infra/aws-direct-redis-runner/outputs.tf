output "generator_instance_ids" {
  description = "EC2 instance IDs for direct Redis generators."
  value       = aws_instance.generator[*].id
}

output "generator_public_dns_names" {
  description = "Public DNS names used to synchronize and manage generators."
  value       = aws_instance.generator[*].public_dns
}

output "generator_private_ips" {
  description = "Private IP addresses for direct Redis generators."
  value       = aws_instance.generator[*].private_ip
}

output "generator_instance_type" {
  description = "EC2 instance type used by every generator."
  value       = var.generator_instance_type
}

output "generator_instance_count" {
  description = "Number of direct Redis generators."
  value       = var.generator_instance_count
}

output "ssh_user" {
  description = "Default Amazon Linux 2023 SSH user."
  value       = "ec2-user"
}
