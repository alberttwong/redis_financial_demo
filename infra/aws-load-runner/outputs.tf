output "instance_id" {
  description = "EC2 instance ID for the load-test runner."
  value       = aws_instance.runner.id
}

output "public_ip" {
  description = "Public IP for SSH-based benchmark runs."
  value       = aws_instance.runner.public_ip
}

output "public_dns" {
  description = "Public DNS for SSH-based benchmark runs."
  value       = aws_instance.runner.public_dns
}

output "ssh_user" {
  description = "Default SSH user for Amazon Linux 2023."
  value       = "ec2-user"
}

output "ready_check" {
  description = "Command to check bootstrap status on the runner."
  value       = "ssh ec2-user@${aws_instance.runner.public_dns} 'test -f /opt/lpl-load-runner-ready && echo ready || tail -n 80 /var/log/cloud-init-output.log'"
}

output "web_url" {
  description = "Ad hoc query workbench URL when web_ingress_cidr_blocks allows access."
  value       = "http://${aws_instance.runner.public_dns}:${var.web_port}"
}
