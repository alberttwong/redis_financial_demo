#!/usr/bin/env bash
set -euxo pipefail

dnf update -y
dnf install -y --allowerasing \
  autoconf \
  automake \
  amazon-cloudwatch-agent \
  curl \
  ethtool \
  gcc \
  gcc-c++ \
  git \
  jq \
  libevent-devel \
  libtool \
  make \
  openssl-devel \
  pcre-devel \
  pkgconf-pkg-config \
  tar \
  zlib-devel

curl -fsSL https://rpm.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
dnf install -y nodejs --allowerasing

if ! command -v memtier_benchmark >/dev/null 2>&1; then
  rm -rf /opt/memtier_benchmark
  git clone --depth 1 https://github.com/RedisLabs/memtier_benchmark.git /opt/memtier_benchmark
  cd /opt/memtier_benchmark
  autoreconf -ivf
  ./configure
  make -j"$(nproc)"
  make install
fi

memtier_benchmark --version
node --version
npm --version

cat >/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'
{
  "agent": {
    "metrics_collection_interval": 60
  },
  "metrics": {
    "namespace": "CWAgent",
    "aggregation_dimensions": [
      [
        "InstanceId"
      ]
    ],
    "append_dimensions": {
      "InstanceId": "${aws:InstanceId}"
    },
    "metrics_collected": {
      "ethtool": {
        "metrics_include": [
          "bw_in_allowance_exceeded",
          "bw_out_allowance_exceeded",
          "pps_allowance_exceeded",
          "conntrack_allowance_exceeded",
          "linklocal_allowance_exceeded"
        ]
      }
    }
  }
}
EOF

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

touch /opt/lpl-load-runner-ready
