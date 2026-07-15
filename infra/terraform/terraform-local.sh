#!/usr/bin/env bash
set -euo pipefail

TERRAFORM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TERRAFORM_DIR/../.." && pwd)"
LOCAL_DIR="$TERRAFORM_DIR/.local"
ENV_FILE="${FIBER_OFFERS_TERRAFORM_ENV_FILE:-$TERRAFORM_DIR/.env.local}"
TF_IMAGE="${FIBER_OFFERS_TERRAFORM_IMAGE:-hashicorp/terraform:1.13.5}"
AWS_PROVIDER_VERSION="5.100.0"
AWS_PROVIDER_ARCHIVE="terraform-provider-aws_${AWS_PROVIDER_VERSION}_linux_amd64.zip"
AWS_PROVIDER_BASE_URL="https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}"
MIRROR_DIR="$LOCAL_DIR/provider-mirror/registry.terraform.io/hashicorp/aws/${AWS_PROVIDER_VERSION}/linux_amd64"

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

[[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE"
[[ -f "$TERRAFORM_DIR/backend.local.hcl" ]] || die "missing backend.local.hcl"
[[ -f "$TERRAFORM_DIR/terraform.tfvars" ]] || die "missing terraform.tfvars"
[[ -f "$LOCAL_DIR/deploy-key.pub" ]] || die "missing .local/deploy-key.pub"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION; do
  [[ -n "${!name:-}" ]] || die "$name is not set in $ENV_FILE"
done

ensure_provider_mirror() {
  local binary="$MIRROR_DIR/terraform-provider-aws_v${AWS_PROVIDER_VERSION}_x5"
  [[ -x "$binary" ]] && return

  command -v curl >/dev/null || die "curl is required"
  command -v sha256sum >/dev/null || die "sha256sum is required"
  command -v unzip >/dev/null || die "unzip is required"

  local downloads="$LOCAL_DIR/downloads"
  mkdir -p "$downloads" "$MIRROR_DIR"

  curl -fsSL "$AWS_PROVIDER_BASE_URL/$AWS_PROVIDER_ARCHIVE" \
    -o "$downloads/$AWS_PROVIDER_ARCHIVE"
  curl -fsSL "$AWS_PROVIDER_BASE_URL/terraform-provider-aws_${AWS_PROVIDER_VERSION}_SHA256SUMS" \
    -o "$downloads/SHA256SUMS"
  grep " $AWS_PROVIDER_ARCHIVE\$" "$downloads/SHA256SUMS" \
    > "$downloads/$AWS_PROVIDER_ARCHIVE.sha256"
  (
    cd "$downloads"
    sha256sum -c "$AWS_PROVIDER_ARCHIVE.sha256"
  )
  unzip -o "$downloads/$AWS_PROVIDER_ARCHIVE" -d "$MIRROR_DIR"
}

ensure_terraform_config() {
  mkdir -p "$LOCAL_DIR"
  if [[ ! -f "$LOCAL_DIR/terraformrc" ]]; then
    printf '%s\n' \
      'provider_installation {' \
      '  filesystem_mirror {' \
      '    path    = "/terraform-local/provider-mirror"' \
      '    include = ["registry.terraform.io/hashicorp/aws"]' \
      '  }' \
      '}' \
      > "$LOCAL_DIR/terraformrc"
  fi
}

ensure_provider_mirror
ensure_terraform_config

command_name="${1:-}"
[[ -n "$command_name" ]] || die "usage: ./terraform-local.sh <init|plan|apply|output|destroy> [arguments...]"
shift

terraform_args=("$command_name" "$@")
if [[ "$command_name" == "init" ]]; then
  terraform_args=(
    init
    -input=false
    -reconfigure
    -backend-config=backend.local.hcl
    "$@"
  )
fi

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_ROOT:/workspace" \
  -v "$LOCAL_DIR:/terraform-local:ro" \
  -w /workspace/infra/terraform \
  -e TF_CLI_CONFIG_FILE=/terraform-local/terraformrc \
  -e AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY \
  -e AWS_SESSION_TOKEN \
  -e AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$AWS_REGION}" \
  "$TF_IMAGE" \
  "${terraform_args[@]}"
