#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

export DEBIAN_FRONTEND=noninteractive

sudo apt update
sudo apt install -y \
    build-essential \
    pkg-config \
    libnetfilter-queue-dev \
    iproute2 \
    iptables \
    tcpdump \
    wireshark \
    iperf3

make -C "${ROOT_DIR}" clean
make -C "${ROOT_DIR}" aodvd

if [ ! -x "${ROOT_DIR}/aodvd" ]; then
    echo "[ERR] Build completed but binary aodvd was not found."
    exit 1
fi

echo "[OK] Built ${ROOT_DIR}/aodvd"
