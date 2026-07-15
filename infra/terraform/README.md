# Fiber Offers AWS Infrastructure

This stack provisions a dedicated Amazon Linux 2023 EC2 instance, subnet,
restricted security group, encrypted gp3 root volume, and stable Elastic IP for
`fiber-offers.leothatguy.me`. It reuses the existing Loavix production VPC and
internet gateway because the AWS account is at its regional VPC quota; compute,
security groups, state, and application data remain separate.

The default `m7i-flex.large` is selected from the instance types that this AWS
account reports as Free Tier eligible.

The S3 backend is intentionally partial. Initialize it with a bucket and a state
key that are distinct from Loavix:

```bash
terraform init \
  -backend-config="bucket=$TERRAFORM_STATE_BUCKET" \
  -backend-config="key=envs/production/fiber-offers/terraform.tfstate" \
  -backend-config="region=$AWS_REGION" \
  -backend-config="use_lockfile=true"
```

Supply AWS credentials through the standard environment variables. Do not put
credentials or SSH private keys in Terraform variables or committed files.

```bash
terraform plan \
  -var="aws_region=$AWS_REGION" \
  -var="public_key_path=/absolute/path/to/deploy-key.pub" \
  -var='ssh_cidr_blocks=["203.0.113.10/32"]'

terraform apply
terraform output -raw public_ip
```

After apply, create this Vercel DNS record:

```text
Name:  fiber-offers
Type:  A
Value: <public_ip>
```
