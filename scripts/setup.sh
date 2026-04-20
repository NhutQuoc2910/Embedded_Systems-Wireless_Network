#!/bin/bash

set -euo pipefail

ACTION="${1:-all}"

readonly NS_A="ns-A"
readonly NS_B="ns-B"
readonly NS_C="ns-C"

cleanup() {
    ip netns del "${NS_A}" 2>/dev/null || true
    ip netns del "${NS_B}" 2>/dev/null || true
    ip netns del "${NS_C}" 2>/dev/null || true
}

create_topology() {
    cleanup

    ip netns add "${NS_A}"
    ip netns add "${NS_B}"
    ip netns add "${NS_C}"

    ip link add veth-AB-a type veth peer name veth-AB-b
    ip link set veth-AB-a netns "${NS_A}"
    ip link set veth-AB-b netns "${NS_B}"

    ip link add veth-BC-b type veth peer name veth-BC-c
    ip link set veth-BC-b netns "${NS_B}"
    ip link set veth-BC-c netns "${NS_C}"

    ip netns exec "${NS_A}" ip addr add 10.0.1.1/24 dev veth-AB-a
    ip netns exec "${NS_B}" ip addr add 10.0.1.2/24 dev veth-AB-b
    ip netns exec "${NS_B}" ip addr add 10.0.2.1/24 dev veth-BC-b
    ip netns exec "${NS_C}" ip addr add 10.0.2.2/24 dev veth-BC-c

    ip netns exec "${NS_A}" ip link set lo up
    ip netns exec "${NS_B}" ip link set lo up
    ip netns exec "${NS_C}" ip link set lo up
    ip netns exec "${NS_A}" ip link set veth-AB-a up
    ip netns exec "${NS_B}" ip link set veth-AB-b up
    ip netns exec "${NS_B}" ip link set veth-BC-b up
    ip netns exec "${NS_C}" ip link set veth-BC-c up

    ip netns exec "${NS_A}" sysctl -q -w net.ipv4.conf.all.rp_filter=0
    ip netns exec "${NS_B}" sysctl -q -w net.ipv4.conf.all.rp_filter=0
    ip netns exec "${NS_C}" sysctl -q -w net.ipv4.conf.all.rp_filter=0
    ip netns exec "${NS_B}" sysctl -q -w net.ipv4.ip_forward=1

    ip netns exec "${NS_A}" ip route replace default dev veth-AB-a
    ip netns exec "${NS_C}" ip route replace default dev veth-BC-c
}

configure_nfqueue() {
    ip netns exec "${NS_A}" iptables -F
    ip netns exec "${NS_B}" iptables -F
    ip netns exec "${NS_C}" iptables -F

    ip netns exec "${NS_A}" iptables -A OUTPUT -d 10.0.1.0/24 -j ACCEPT
    ip netns exec "${NS_A}" iptables -A OUTPUT -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_A}" iptables -A OUTPUT -j NFQUEUE --queue-num 0
    ip netns exec "${NS_A}" iptables -A FORWARD -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_A}" iptables -A FORWARD -j NFQUEUE --queue-num 0

    ip netns exec "${NS_B}" iptables -A OUTPUT -d 10.0.1.0/24 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A OUTPUT -d 10.0.2.0/24 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A OUTPUT -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A OUTPUT -j NFQUEUE --queue-num 0
    ip netns exec "${NS_B}" iptables -A FORWARD -d 10.0.1.0/24 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A FORWARD -d 10.0.2.0/24 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A FORWARD -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_B}" iptables -A FORWARD -j NFQUEUE --queue-num 0

    ip netns exec "${NS_C}" iptables -A OUTPUT -d 10.0.2.0/24 -j ACCEPT
    ip netns exec "${NS_C}" iptables -A OUTPUT -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_C}" iptables -A OUTPUT -j NFQUEUE --queue-num 0
    ip netns exec "${NS_C}" iptables -A FORWARD -p udp --dport 654 -j ACCEPT
    ip netns exec "${NS_C}" iptables -A FORWARD -j NFQUEUE --queue-num 0
}

case "${ACTION}" in
    topology)
        create_topology
        ;;
    nfqueue)
        configure_nfqueue
        ;;
    all)
        create_topology
        configure_nfqueue
        ;;
    cleanup)
        cleanup
        ;;
    *)
        echo "Usage: sudo ./scripts/setup.sh [topology|nfqueue|all|cleanup]"
        exit 1
        ;;
esac

echo "[OK] setup.sh completed: ${ACTION}"
