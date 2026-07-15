output "public_ip" {
  description = "Elastic IP to assign to fiber-offers.leothatguy.me"
  value       = aws_eip.app.public_ip
}

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.app.id
}

output "ssh_command" {
  description = "SSH command for the provisioned server"
  value       = "ssh ec2-user@${aws_eip.app.public_ip}"
}

output "dashboard_domain" {
  description = "DNS name to configure after apply"
  value       = "fiber-offers.leothatguy.me"
}

output "free_tier_instance_types" {
  description = "EC2 instance types allowed by the account's current Free Tier restriction"
  value       = data.aws_ec2_instance_types.free_tier.instance_types
}
