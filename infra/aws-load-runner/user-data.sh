#!/usr/bin/env bash
set -euxo pipefail

dnf update -y
dnf install -y --allowerasing \
  autoconf \
  automake \
  curl \
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

touch /opt/lpl-load-runner-ready
