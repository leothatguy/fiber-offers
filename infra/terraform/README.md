# Fiber Offers AWS Infrastructure

This stack provisions a dedicated Amazon Linux 2023 EC2 instance, subnet,
restricted security group, encrypted gp3 root volume, and stable Elastic IP for
`fiber-offers.leothatguy.me`. It reuses the existing Loavix production VPC and
internet gateway because the AWS account is at its regional VPC quota; compute,
security groups, state, and application data remain separate.

The default `m7i-flex.large` is selected from the instance types that this AWS
account reports as Free Tier eligible.

Terraform is run locally through Docker; GitHub Actions are not involved. The
authoritative state is stored remotely in S3 under a key distinct from Loavix:

```text
envs/production/fiber-offers/terraform.tfstate
```

Project-local credentials, backend configuration, variables, provider mirror,
and SSH public key live in ignored files:

```text
.env.local
backend.local.hcl
terraform.tfvars
.local/
```

Initialize with the local wrapper:

```bash
./terraform-local.sh init
```

The wrapper verifies the pinned AWS provider checksum, uses the project-local
provider mirror, and passes the ignored AWS environment into the Terraform
container. Do not commit credentials, Terraform state, plans, or SSH private
keys.

```bash
./terraform-local.sh plan -out=fiber-offers.tfplan
./terraform-local.sh apply fiber-offers.tfplan
./terraform-local.sh output
./terraform-local.sh output -raw public_ip
```

After apply, create this Vercel DNS record:

```text
Name:  fiber-offers
Type:  A
Value: <public_ip>
```
