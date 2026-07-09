#!/usr/bin/env bash
set -euxo pipefail

dnf update -y
dnf install -y \
  autoconf \
  automake \
  gcc \
  gcc-c++ \
  git \
  jq \
  libtool \
  make \
  nodejs \
  npm \
  openssl-devel \
  pcre-devel \
  tar \
  zlib-devel

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
