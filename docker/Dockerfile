FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies for AODV and networking tools
RUN apt-get update && apt-get install -y \
    build-essential \
    pkg-config \
    libnetfilter-queue-dev \
    iptables \
    iproute2 \
    tcpdump \
    iputils-ping \
    net-tools \
    kmod \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /aodv

# Copy project files
COPY . /aodv

# Compile AODV-UU source code
RUN make clean && make aodvd

# Ensure entrypoint is executable
RUN chmod +x /aodv/docker/entrypoint.sh

ENTRYPOINT ["/aodv/docker/entrypoint.sh"]
