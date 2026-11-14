#!/bin/sh
# Ubuntu 24.04 host bootstrap; contains no application credentials.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 openssl curl
systemctl enable --now docker
# Emergency headroom on the included disk, not additional paid storage.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
printf 'vm.swappiness=10\n' > /etc/sysctl.d/90-opendoc-poc.conf
sysctl --system
mkdir -p /opt/opendoc
chmod 700 /opt/opendoc
