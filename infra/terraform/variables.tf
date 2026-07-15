variable "aws_region" {
  description = "AWS region for the merchant deployment"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for FNN, resolver replicas, PostgreSQL, and Redis"
  type        = string
  default     = "m7i-flex.large"
}

variable "root_volume_size" {
  description = "Encrypted gp3 root volume size in GiB"
  type        = number
  default     = 50
}

variable "app_name" {
  description = "Resource name prefix"
  type        = string
  default     = "fiber-offers"
}

variable "environment" {
  description = "Deployment environment label"
  type        = string
  default     = "production"
}

variable "host_vpc_name" {
  description = "Existing VPC reused because the AWS account is at its regional VPC quota"
  type        = string
  default     = "loavix-production-vpc"
}

variable "subnet_cidr" {
  description = "Dedicated Fiber Offers subnet inside the host VPC"
  type        = string
  default     = "10.42.2.0/24"
}

variable "public_key_path" {
  description = "Local path to the SSH public key registered with EC2"
  type        = string
}

variable "ssh_cidr_blocks" {
  description = "CIDR blocks allowed to connect over key-authenticated SSH"
  type        = list(string)

  validation {
    condition     = length(var.ssh_cidr_blocks) > 0
    error_message = "At least one SSH CIDR block is required."
  }
}
