#!/bin/bash
set -e

echo "=========================================="
echo " Starting AODV Node Container"
echo "=========================================="

# 1. Enable IP forwarding and disable Reverse Path Filtering
sysctl -w net.ipv4.ip_forward=1
sysctl -w net.ipv4.conf.all.rp_filter=0 || true

# 2. Remove default routes so Docker doesn't bypass AODV for routing
ip route del default 2>/dev/null || true

# 3. Configure iptables to redirect traffic to NFQUEUE (Queue 0)
iptables -F

# CRITICAL: We MUST exempt AODV control traffic (UDP port 654) from NFQUEUE.
# If AODV control packets (HELLO/RREQ/RREP) go to NFQUEUE, aodvd will intercept 
# its own packets, causing an infinite loop or dropped packets.
iptables -A INPUT -p udp --dport 654 -j ACCEPT
iptables -A OUTPUT -p udp --dport 654 -j ACCEPT
iptables -A FORWARD -p udp --dport 654 -j ACCEPT

# Redirect all other traffic to NFQUEUE for AODV routing
iptables -A INPUT -j NFQUEUE --queue-num 0
iptables -A OUTPUT -j NFQUEUE --queue-num 0
iptables -A FORWARD -j NFQUEUE --queue-num 0

# 4. Dynamically detect network interfaces
# Find all interfaces except loopback that have an IPv4 address assigned
INTERFACES=$(ip -o link show | awk -F': ' '{print $2}' | cut -d'@' -f1 | grep -v lo)

AODV_ARGS=""
for iface in $INTERFACES; do
    # Only bind to interfaces that have an IPv4 address
    if ip -4 addr show "$iface" | grep -q 'inet '; then
        AODV_ARGS="$AODV_ARGS -i $iface"
    fi
done

echo "[*] Detected Interfaces: $AODV_ARGS"
echo "[*] Starting aodvd: /aodv/aodvd $AODV_ARGS -l -d"
echo "=========================================="

# 5. Launch aodvd in the foreground
exec /aodv/aodvd $AODV_ARGS -l -d
