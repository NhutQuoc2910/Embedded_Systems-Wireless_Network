"""
app.py — AODV-UU Network Dashboard Backend
Flask + Flask-SocketIO server for fully dynamic namespace management.

Changes from v1:
  - Topology is FREE: nodes have no automatic links on creation.
    Links are created explicitly via POST /api/link.
  - Routing table cards are generated dynamically from node list.
  - WebSocket logs are tagged per-namespace so frontend can route
    each line to the correct tab.

Run with:
    sudo python app.py

Requirements:
    pip install flask flask-socketio eventlet
"""

import eventlet
eventlet.monkey_patch()

import subprocess
import threading
import shlex
import re
import os
import time as _time
from typing import Dict, List, Tuple
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit

# Absolute path to aodvd binary — lives one level above gui/
BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
AODVD_BIN = os.path.normpath(os.path.join(BASE_DIR, "..", "aodvd"))

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__, static_folder="static")
app.config["SECRET_KEY"] = "aodv-uu-secret"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# ---------------------------------------------------------------------------
# In-memory topology state
#
# nodes : { "ns-A": { "name": "ns-A", "ips": ["10.0.1.1", ...] }, ... }
# links : [
#   {
#     "id":       "ns-A--ns-B",
#     "src":      "ns-A",
#     "dst":      "ns-B",
#     "veth_src": "veth-AB-s",
#     "veth_dst": "veth-AB-d",
#     "ip_src":   "10.0.1.1",
#     "ip_dst":   "10.0.1.2",
#     "up":       True,
#   }, ...
# ]
# procs : { "ns-A": <Popen> }  — running aodvd processes
# ---------------------------------------------------------------------------

topology = {
    "nodes": {},
    "links": [],
}

aodvd_procs: Dict[str, subprocess.Popen] = {}
aodvd_lock  = threading.Lock()

# Global link counter — monotonically increasing, never reused.
# This ensures IP subnets are always unique even after link deletion.
_link_counter = 0
_link_counter_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_cmd(cmd: str, netns: str = None) -> Tuple[str, str, int]:
    """Execute a shell command, optionally inside a network namespace."""
    if netns:
        cmd = f"ip netns exec {netns} {cmd}"
    try:
        result = subprocess.run(
            shlex.split(cmd),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip(), result.stderr.strip(), result.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", 1
    except Exception as e:
        return "", str(e), 1


def emit_log(msg: str, level: str = "info", ns: str = "system"):
    """
    Broadcast a log line to all WebSocket clients.
    'ns' is used by the frontend to route the line to the correct tab.
    Use ns="system" for events not tied to a specific namespace.
    """
    socketio.emit("log", {"ns": ns, "level": level, "msg": msg})


def _next_link_index() -> int:
    global _link_counter
    with _link_counter_lock:
        idx = _link_counter
        _link_counter += 1
    return idx


def _link_ips(index: int) -> Tuple[str, str]:
    """
    Allocate a unique /24 subnet for link number `index`.
    index 0  → 10.0.1.1 / 10.0.1.2
    index 1  → 10.0.2.1 / 10.0.2.2
    index 255→ 10.1.0.1 / 10.1.0.2  (wraps correctly)
    """
    high = index // 255
    low  = (index % 255) + 1
    return f"10.{high}.{low}.1", f"10.{high}.{low}.2"


def _veth_names(src: str, dst: str, index: int) -> Tuple[str, str]:
    """
    Generate unique, deterministic veth names.
    Include index so the same pair can be re-linked after deletion.
    Max interface name length in Linux is 15 chars.
    """
    a = src.replace("ns-", "")[:4]
    b = dst.replace("ns-", "")[:4]
    return f"v{a}{b}{index}s", f"v{a}{b}{index}d"


def _ns_exists(ns: str) -> bool:
    out, _, _ = run_cmd("ip netns list")
    return any(line.split()[0] == ns for line in out.splitlines() if line.strip())


def _get_node_ifaces(ns: str) -> List[str]:
    """Return all non-loopback interface names inside a namespace."""
    out, _, _ = run_cmd("ip -o link show", netns=ns)
    ifaces = []
    for line in out.splitlines():
        m = re.match(r"\d+:\s+(\S+?)[@:]", line)
        if m and m.group(1) != "lo":
            ifaces.append(m.group(1))
    return ifaces


def _build_topology_event() -> dict:
    live_ns = set()
    out, _, _ = run_cmd("ip netns list")
    for line in out.splitlines():
        if line.strip():
            live_ns.add(line.split()[0])
    nodes_out = []
    for name, meta in topology["nodes"].items():
        nodes_out.append({
            **meta,
            "alive": name in live_ns,
            "aodvd": name in aodvd_procs and aodvd_procs[name].poll() is None,
        })
    return {"nodes": nodes_out, "links": list(topology["links"])}


# ---------------------------------------------------------------------------
# Namespace lifecycle
# ---------------------------------------------------------------------------

def _create_namespace(ns: str) -> bool:
    if _ns_exists(ns):
        emit_log(f"{ns} already exists, skipping.", "warn", ns)
        return True
    _, err, rc = run_cmd(f"ip netns add {ns}")
    if rc != 0:
        emit_log(f"Failed to create {ns}: {err}", "error", ns)
        return False
    run_cmd(f"ip netns exec {ns} ip link set lo up")
    emit_log(f"Namespace {ns} created.", "info", ns)
    return True


def _delete_namespace(ns: str):
    run_cmd(f"ip netns del {ns}")
    emit_log(f"Namespace {ns} deleted.", "info", ns)


# ---------------------------------------------------------------------------
# Link lifecycle
# ---------------------------------------------------------------------------

def _create_veth_link(src_ns: str, dst_ns: str,
                       veth_s: str, veth_d: str,
                       ip_s: str, ip_d: str) -> bool:
    """Wire two namespaces together with a veth pair."""
    for cmd in [
        f"ip link add {veth_s} type veth peer name {veth_d}",
        f"ip link set {veth_s} netns {src_ns}",
        f"ip link set {veth_d} netns {dst_ns}",
    ]:
        _, err, rc = run_cmd(cmd)
        if rc != 0:
            emit_log(f"veth error: {err}", "error", "system")
            return False

    run_cmd(f"ip addr add {ip_s}/24 dev {veth_s}", netns=src_ns)
    run_cmd(f"ip link set {veth_s} up",             netns=src_ns)
    run_cmd(f"ip addr add {ip_d}/24 dev {veth_d}", netns=dst_ns)
    run_cmd(f"ip link set {veth_d} up",             netns=dst_ns)

    emit_log(
        f"Link created: {src_ns}({ip_s}) ↔ {dst_ns}({ip_d})"
        f"  [{veth_s}/{veth_d}]",
        "info", "system",
    )
    return True


def _delete_veth_link(src_ns: str, veth_s: str):
    """Removing one side of a veth pair removes both ends."""
    run_cmd(f"ip link del {veth_s}", netns=src_ns)
    emit_log(f"Veth {veth_s} deleted from {src_ns}.", "info", "system")


# ---------------------------------------------------------------------------
# NFQUEUE
# ---------------------------------------------------------------------------

def _configure_nfqueue(ns: str):
    ifaces = _get_node_ifaces(ns)
    # Flush first so re-running is idempotent
    run_cmd("iptables -F OUTPUT",  netns=ns)
    run_cmd("iptables -F FORWARD", netns=ns)
    run_cmd("iptables -A OUTPUT  -j NFQUEUE --queue-num 0", netns=ns)
    run_cmd("iptables -A FORWARD -j NFQUEUE --queue-num 0", netns=ns)
    if len(ifaces) > 1:
        run_cmd("sysctl -w net.ipv4.ip_forward=1", netns=ns)
    emit_log(
        f"NFQUEUE enabled on {ns} (ifaces: {', '.join(ifaces) or 'none yet'}).",
        "info", ns,
    )


# ---------------------------------------------------------------------------
# aodvd process management
# ---------------------------------------------------------------------------

def _parse_aodv_event(ns: str, line: str):
    """
    Parse an aodvd log line and emit a structured aodv_event if recognized.
    Events: rreq_send, rreq_recv, rreq_forward, rreq_dup,
            rrep_send, rrep_recv, rrep_forward,
            rerr_send, rerr_recv,
            hello_send, route_add, route_expire
    """
    low = line.lower()
    event = None

    if "sending rreq" in low or "rreq to" in low:
        event = {"type": "rreq_send", "node": ns, "msg": line.strip()}
    elif "received rreq" in low or "rreq from" in low:
        event = {"type": "rreq_recv", "node": ns, "msg": line.strip()}
    elif "forwarding rreq" in low or "forward rreq" in low:
        event = {"type": "rreq_forward", "node": ns, "msg": line.strip()}
    elif "duplicate rreq" in low or "already processed" in low:
        event = {"type": "rreq_dup", "node": ns, "msg": line.strip()}
    elif "sending rrep" in low or "rrep to" in low:
        event = {"type": "rrep_send", "node": ns, "msg": line.strip()}
    elif "received rrep" in low or "rrep from" in low:
        event = {"type": "rrep_recv", "node": ns, "msg": line.strip()}
    elif "forwarding rrep" in low or "forward rrep" in low:
        event = {"type": "rrep_forward", "node": ns, "msg": line.strip()}
    elif "sending rerr" in low or "rerr" in low and "send" in low:
        event = {"type": "rerr_send", "node": ns, "msg": line.strip()}
    elif "received rerr" in low or "rerr" in low and "recv" in low:
        event = {"type": "rerr_recv", "node": ns, "msg": line.strip()}
    elif "hello" in low and ("send" in low or "start" in low):
        event = {"type": "hello_send", "node": ns, "msg": line.strip()}
    elif "adding route" in low or "route add" in low or "new route" in low:
        event = {"type": "route_add", "node": ns, "msg": line.strip()}
    elif "route timeout" in low or "expire" in low or "invalid" in low:
        event = {"type": "route_expire", "node": ns, "msg": line.strip()}
    elif "nfqueue" in low or "verdict" in low or "nf_accept" in low:
        event = {"type": "nfqueue_verdict", "node": ns, "msg": line.strip()}

    if event:
        import time
        event["ts"] = time.strftime("%H:%M:%S")
        socketio.emit("aodv_event", event)


def _stream_aodvd(ns: str, proc: subprocess.Popen):
    """Background thread: forward every aodvd output line to WebSocket clients."""
    try:
        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip()
            if not line:
                continue
            low = line.lower()
            level = (
                "error" if any(w in low for w in ["error", "fail", "panic"])
                else "warn" if "warn" in low
                else "info"
            )
            # Tag with namespace so frontend puts it in the right tab
            socketio.emit("log", {"ns": ns, "level": level, "msg": line})
            # Also parse for structured AODV events
            _parse_aodv_event(ns, line)
        proc.wait()
        emit_log(f"aodvd exited (rc={proc.returncode}).", "warn", ns)
    except Exception as exc:
        emit_log(f"Stream error: {exc}", "error", ns)


def _start_aodvd(ns: str) -> bool:
    import time
    ifaces = _get_node_ifaces(ns)
    if not ifaces:
        emit_log("No interfaces — attach at least one link first.", "error", ns)
        return False

    with aodvd_lock:
        # Xóa default route cũ nếu có (tránh conflict)
        run_cmd("ip route del 10.0.0.0/8", netns=ns) 
        
        # Thêm catch-all route cho toàn bộ 10.x.x.x
        # Kernel sẽ đưa gói tin vào OUTPUT chain -> lọt vào NFQUEUE -> AODV chụp được
        first_iface = ifaces[0]
        run_cmd(f"ip route add 10.0.0.0/8 dev {first_iface} metric 200", netns=ns)
        emit_log(f"Added catch-all route 10.0.0.0/8 via {first_iface}", "info", ns)

        # Stop existing instance if running
        if ns in aodvd_procs and aodvd_procs[ns].poll() is None:
            emit_log(f"Restarting aodvd on {ns} with updated ifaces.", "info", ns)
            old_proc = aodvd_procs.pop(ns)
            old_proc.terminate()
            try:
                old_proc.wait(timeout=2)
            except Exception:
                old_proc.kill()
            time.sleep(0.3)

        # Kill any stale process still holding UDP port 654
        _ns_path = f"/var/run/netns/{ns}"
        subprocess.run(
            ["nsenter", "--net=" + _ns_path, "fuser", "-k", "654/udp"],
            capture_output=True
        )
        time.sleep(0.4)

        # Force line-buffering using stdbuf so aodvd logs flush immediately to python pipeline
        iface_arg = ",".join(ifaces)

        # --- Per-namespace rtlog isolation ---
        # Network namespaces share the filesystem, so all aodvd instances
        # would write to the same /var/log/aodvd.rtlog.  We fix this by:
        #   1. Creating a per-ns file: /tmp/aodvd-{ns}.rtlog
        #   2. Using unshare --mount to give aodvd its own mount namespace
        #   3. Bind-mounting the per-ns file over /var/log/aodvd.rtlog
        rtlog_path = f"/tmp/aodvd-{ns}.rtlog"
        # Ensure the per-ns file and target exist
        for p in [rtlog_path, "/var/log/aodvd.rtlog"]:
            subprocess.run(["touch", p], capture_output=True)

        shell_cmd = (
            f"ip netns exec {ns} unshare --mount -- bash -c '"
            f"mount --bind {rtlog_path} /var/log/aodvd.rtlog && "
            f"exec stdbuf -oL -eL {AODVD_BIN} -D -r 1 -i {iface_arg}'"
        )
        try:
            proc = subprocess.Popen(
                shell_cmd,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except Exception as e:
            emit_log("aodvd binary not found — run 'make aodvd' first.", "error", ns)
            return False

        aodvd_procs[ns] = proc
        socketio.start_background_task(target=_stream_aodvd, ns=ns, proc=proc)
        emit_log(f"aodvd started (pid={proc.pid}, ifaces={iface_arg}).", "info", ns)
        return True


def _stop_aodvd(ns: str):
    with aodvd_lock:
        proc = aodvd_procs.pop(ns, None)
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        emit_log("aodvd stopped.", "info", ns)
    else:
        emit_log("No running aodvd to stop.", "warn", ns)
    # Note: keep /tmp/aodvd-{ns}.rtlog so it can still be read after stop


# ---------------------------------------------------------------------------
# REST API — static files
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ---------------------------------------------------------------------------
# REST API — topology read
# ---------------------------------------------------------------------------

@app.route("/api/topology", methods=["GET"])
def get_topology():
    """Full topology snapshot including live namespace and aodvd status."""
    live_ns = set()
    out, _, _ = run_cmd("ip netns list")
    for line in out.splitlines():
        if line.strip():
            live_ns.add(line.split()[0])

    nodes_out = []
    for name, meta in topology["nodes"].items():
        nodes_out.append({
            **meta,
            "alive": name in live_ns,
            "aodvd": name in aodvd_procs and aodvd_procs[name].poll() is None,
        })

    return jsonify({"nodes": nodes_out, "links": list(topology["links"])})


# ---------------------------------------------------------------------------
# REST API — node management
# ---------------------------------------------------------------------------

@app.route("/api/node", methods=["POST"])
def add_node():
    """
    Create a new isolated namespace node.
    No links are created automatically — user wires them manually via POST /api/link.

    Body (all optional):
      { "name": "ns-D" }

    If name is omitted, the next letter after the last node is used.
    """
    data = request.get_json(force=True) or {}

    if "name" in data and data["name"].strip():
        ns = data["name"].strip()
    else:
        existing = list(topology["nodes"].keys())
        if existing:
            last_letter = existing[-1].replace("ns-", "")
            ns = f"ns-{chr(ord(last_letter[-1]) + 1)}"
        else:
            ns = "ns-A"

    if ns in topology["nodes"]:
        return jsonify({"ok": False, "error": f"{ns} already exists"}), 400

    if not _create_namespace(ns):
        return jsonify({"ok": False, "error": f"Kernel refused to create {ns}"}), 500

    topology["nodes"][ns] = {"name": ns, "ips": []}

    emit_log(f"Node {ns} added (no links yet).", "info", ns)

    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True, "node": ns})


@app.route("/api/node/<ns>", methods=["DELETE"])
def remove_node(ns):
    """
    Remove a node and all its links.
    Stops aodvd if running, cleans up all veth pairs.
    """
    if ns not in topology["nodes"]:
        return jsonify({"ok": False, "error": "Node not found"}), 404

    if ns in aodvd_procs:
        _stop_aodvd(ns)

    # Collect and remove every link touching this node
    touching = [l for l in topology["links"] if l["src"] == ns or l["dst"] == ns]
    for link in touching:
        try:
            _delete_veth_link(link["src"], link["veth_src"])
        except Exception:
            pass
        topology["links"].remove(link)
        # Remove the IP from the other node's ip list
        other = link["dst"] if link["src"] == ns else link["src"]
        other_ip = link["ip_dst"] if link["src"] == ns else link["ip_src"]
        if other in topology["nodes"]:
            topology["nodes"][other]["ips"] = [
                ip for ip in topology["nodes"][other]["ips"] if ip != other_ip
            ]

    _delete_namespace(ns)
    del topology["nodes"][ns]

    emit_log(f"Node {ns} removed.", "warn", ns)
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# REST API — link management (FREE topology)
# ---------------------------------------------------------------------------

@app.route("/api/link", methods=["POST"])
def add_link():
    """
    Create a link (veth pair) between any two existing nodes.
    Duplicate links between the same pair are allowed (they get different IPs).

    Body: { "src": "ns-A", "dst": "ns-C" }
    """
    data = request.get_json(force=True) or {}
    src  = data.get("src", "").strip()
    dst  = data.get("dst", "").strip()

    if not src or not dst:
        return jsonify({"ok": False, "error": "src and dst are required"}), 400
    if src == dst:
        return jsonify({"ok": False, "error": "src and dst must differ"}), 400
    if src not in topology["nodes"]:
        return jsonify({"ok": False, "error": f"Node {src} not found"}), 404
    if dst not in topology["nodes"]:
        return jsonify({"ok": False, "error": f"Node {dst} not found"}), 404

    idx          = _next_link_index()
    veth_s, veth_d = _veth_names(src, dst, idx)
    ip_s, ip_d   = _link_ips(idx)
    link_id      = f"{src}--{dst}--{idx}"

    ok = _create_veth_link(src, dst, veth_s, veth_d, ip_s, ip_d)
    if not ok:
        return jsonify({"ok": False, "error": "veth creation failed — check logs"}), 500

    topology["links"].append({
        "id":       link_id,
        "src":      src,
        "dst":      dst,
        "veth_src": veth_s,
        "veth_dst": veth_d,
        "ip_src":   ip_s,
        "ip_dst":   ip_d,
        "up":       True,
    })
    topology["nodes"][src]["ips"].append(ip_s)
    topology["nodes"][dst]["ips"].append(ip_d)

    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True, "link_id": link_id, "ip_src": ip_s, "ip_dst": ip_d})


@app.route("/api/link/<path:link_id>", methods=["DELETE"])
def remove_link(link_id):
    """Delete a specific link by its id."""
    link = next((l for l in topology["links"] if l["id"] == link_id), None)
    if not link:
        return jsonify({"ok": False, "error": "Link not found"}), 404

    try:
        _delete_veth_link(link["src"], link["veth_src"])
    except Exception as exc:
        emit_log(f"Warning during veth deletion: {exc}", "warn", "system")

    topology["links"].remove(link)

    # Remove IPs from node metadata
    for ns, ip_key in [(link["src"], "ip_src"), (link["dst"], "ip_dst")]:
        if ns in topology["nodes"]:
            topology["nodes"][ns]["ips"] = [
                ip for ip in topology["nodes"][ns]["ips"] if ip != link[ip_key]
            ]

    emit_log(f"Link {link_id} deleted.", "info", "system")
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True})


@app.route("/api/link/<path:link_id>/toggle", methods=["POST"])
def toggle_link(link_id):
    """
    Simulate link failure: toggle a link between up and down.
    This is the key action for the 'Link Failure' demo scenario.
    """
    link = next((l for l in topology["links"] if l["id"] == link_id), None)
    if not link:
        return jsonify({"ok": False, "error": "Link not found"}), 404

    action = "down" if link["up"] else "up"
    run_cmd(f"ip link set {link['veth_src']} {action}", netns=link["src"])
    run_cmd(f"ip link set {link['veth_dst']} {action}", netns=link["dst"])
    link["up"] = not link["up"]

    level = "warn" if action == "down" else "info"
    emit_log(
        f"Link {link['src']} ↔ {link['dst']} set {action.upper()}.",
        level, "system",
    )
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True, "link_up": link["up"]})


# ---------------------------------------------------------------------------
# REST API — NFQUEUE
# ---------------------------------------------------------------------------

@app.route("/api/nfqueue", methods=["POST"])
def enable_nfqueue():
    """Configure NFQUEUE on all nodes (or one via ?ns=ns-A)."""
    target = request.args.get("ns")
    nodes  = [target] if target else list(topology["nodes"].keys())
    for ns in nodes:
        _configure_nfqueue(ns)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# REST API — aodvd
# ---------------------------------------------------------------------------

@app.route("/api/aodv/start", methods=["POST"])
def start_aodv():
    """Start aodvd on all nodes (or one via ?ns=ns-A)."""
    target  = request.args.get("ns")
    nodes   = [target] if target else list(topology["nodes"].keys())
    results = {}
    for ns in nodes:
        results[ns] = _start_aodvd(ns)
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True, "results": results})


@app.route("/api/aodv/stop", methods=["POST"])
def stop_aodv():
    """Stop aodvd on all nodes (or one via ?ns=ns-A)."""
    target = request.args.get("ns")
    nodes  = [target] if target else list(aodvd_procs.keys())
    for ns in list(nodes):
        _stop_aodvd(ns)
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# REST API — routing tables (dynamic, driven by current node list)
# ---------------------------------------------------------------------------

@app.route("/api/routing", methods=["GET"])
def get_routing():
    """
    Return routing tables for all current nodes (or one via ?ns=ns-A).
    Returns both kernel routes (ip route show) and NFQUEUE/iptables state
    so the frontend can show the full AODV picture.
    """
    target = request.args.get("ns")
    nodes  = [target] if target else list(topology["nodes"].keys())
    tables = {}
    for ns in nodes:
        # 1. Kernel routing table (routes learned via AODV rtnetlink)
        kr_out, kr_err, kr_rc = run_cmd("ip route show", netns=ns)

        # 2. NFQUEUE iptables rules — proof that our solution is active
        nfq_out, _, _ = run_cmd("iptables -L OUTPUT -n --line-numbers", netns=ns)
        nfq_fwd, _, _ = run_cmd("iptables -L FORWARD -n --line-numbers", netns=ns)
        nfqueue_active = "NFQUEUE" in nfq_out or "NFQUEUE" in nfq_fwd

        # 3. Interface list with state
        iface_out, _, _ = run_cmd("ip -o link show", netns=ns)
        ifaces = []
        for line in iface_out.splitlines():
            m = re.match(r"\d+:\s+(\S+?)[@:].*state\s+(\S+)", line)
            if m and m.group(1) != "lo":
                ifaces.append(f"{m.group(1)} [{m.group(2)}]")

        tables[ns] = {
            "routes":         kr_out if kr_rc == 0 else "",
            "error":          kr_err if kr_rc != 0 else "",
            "ips":            topology["nodes"].get(ns, {}).get("ips", []),
            "nfqueue_active": nfqueue_active,
            "ifaces":         ifaces,
            "aodvd_running":  ns in aodvd_procs and aodvd_procs[ns].poll() is None,
        }
    return jsonify(tables)


# ---------------------------------------------------------------------------
# AODV routing table log parser
# ---------------------------------------------------------------------------

def _parse_aodv_rtlog(ns: str) -> dict:
    """
    Read and parse /var/log/aodvd.rtlog inside a namespace.
    Returns a dict with metadata and a list of route entries.

    The rtlog format (written by aodvd's print_rt_table in debug.c):
        # Time: HH:MM:SS.mmm IP: x.x.x.x seqno: N entries/active: N/N
        Destination     Next hop        HC  St. Seqno Expire Flags Iface Precursors
        10.0.1.2        10.0.1.2        1   VAL 5     2894   ---   veth0 10.0.2.1

    IMPORTANT: rt_flags_to_str() returns "" when flags==0, so the %-5s
    format produces 5 spaces that split() silently absorbs.  We must
    parse by FIXED COLUMN POSITIONS derived from the sprintf widths:

        Col 0..14  (15) Destination   %-15s
        Col 16..30 (15) Next hop      %-15s  (1 space gap)
        Col 32..34 (3)  HC            %-3d   (1 space gap)
        Col 36..38 (3)  St.           %-3s   (1 space gap)
        Col 40..44 (5)  Seqno         %-5s   (1 space gap)
        Col 46..51 (6)  Expire        %-6lu  (1 space gap)
        Col 53..57 (5)  Flags         %-5s   (1 space gap)
        Col 59..63 (5)  Iface         %-5s   (1 space gap)
        Col 65..   (*)  Precursors    %-15s  (optional)

    We use a hybrid approach: try fixed-position first, fall back to
    split-based parsing for robustness.
    """
    # Read the per-namespace rtlog file directly (not via ip netns exec,
    # since the filesystem is shared and we use per-ns files in /tmp).
    rtlog_path = f"/tmp/aodvd-{ns}.rtlog"
    try:
        with open(rtlog_path, "r") as f:
            out = f.read().strip()
        err, rc = "", 0
    except FileNotFoundError:
        out, err, rc = "", "rtlog not found (aodvd not started with -r?)", 1
    except Exception as e:
        out, err, rc = "", str(e), 1

    result = {
        "timestamp": "",
        "host_ip": "",
        "host_seqno": 0,
        "entries": 0,
        "active": 0,
        "routes": [],
        "raw": out if rc == 0 else "",
        "error": err if rc != 0 else "",
    }

    if rc != 0 or not out.strip():
        return result

    lines = out.strip().splitlines()

    # Find the LAST complete block (aodvd appends to file, we want freshest)
    # Blocks start with "# Time: ..."
    last_header_idx = -1
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].startswith("# Time:"):
            last_header_idx = i
            break

    if last_header_idx == -1:
        return result

    # Parse header: # Time: HH:MM:SS.mmm IP: x.x.x.x seqno: N entries/active: N/N
    header = lines[last_header_idx]
    hm = re.match(
        r"# Time:\s+(\S+)\s+IP:\s+(\S+)\s+seqno:\s+(\d+)\s+entries/active:\s+(\d+)/(\d+)",
        header,
    )
    if hm:
        result["timestamp"] = hm.group(1)
        result["host_ip"]   = hm.group(2)
        result["host_seqno"] = int(hm.group(3))
        result["entries"]   = int(hm.group(4))
        result["active"]    = int(hm.group(5))

    # --- Detect column positions from the header line -----------------
    # The line right after "# Time:" is the column header:
    #   "Destination     Next hop        HC  St. Seqno Expire Flags Iface Precursors"
    # We parse its positions to handle any minor format variations.
    col_header_idx = last_header_idx + 1
    col_positions = None
    if col_header_idx < len(lines):
        ch = lines[col_header_idx]
        # Find start positions of each known column keyword
        col_keywords = [
            "Destination", "Next hop", "HC", "St.", "Seqno",
            "Expire", "Flags", "Iface", "Precursors",
        ]
        positions = []
        for kw in col_keywords:
            idx = ch.find(kw)
            if idx >= 0:
                positions.append(idx)
            else:
                positions.append(None)
        # Only use fixed-position parsing if at least the first 8 columns found
        if all(p is not None for p in positions[:8]):
            col_positions = positions

    data_start = last_header_idx + 2

    current_route = None
    for line in lines[data_start:]:
        stripped = line.strip()
        if not stripped:
            continue
        # A new block header means end of current block
        if stripped.startswith("# Time:"):
            break

        # Check if this is a precursor continuation line (heavily indented)
        # Continuation lines have lots of leading spaces followed by a single IP
        cont_match = re.match(r"^\s{20,}(\d+\.\d+\.\d+\.\d+)$", line)
        if cont_match and current_route:
            current_route["precursors"].append(cont_match.group(1))
            continue

        # --- Fixed-position parsing (preferred) ---
        if col_positions and len(line) >= (col_positions[7] if col_positions[7] else 0):
            try:
                p = col_positions  # shorthand
                dest      = line[p[0]:p[1]].strip()   if p[0] is not None else ""
                next_hop  = line[p[1]:p[2]].strip()   if p[1] is not None else ""
                hcnt_s    = line[p[2]:p[3]].strip()   if p[2] is not None else "0"
                state     = line[p[3]:p[4]].strip()   if p[3] is not None else ""
                seqno_s   = line[p[4]:p[5]].strip()   if p[4] is not None else "-"
                expire_s  = line[p[5]:p[6]].strip()   if p[5] is not None else "0"
                flags     = line[p[6]:p[7]].strip()   if p[6] is not None else ""
                # Iface: from position[7] to position[8] (or end if no precursors col)
                iface_end = p[8] if p[8] is not None else len(line)
                iface     = line[p[7]:iface_end].strip() if p[7] is not None else ""
                # Precursors: everything after position[8]
                prec_str  = line[p[8]:].strip() if p[8] is not None and p[8] < len(line) else ""

                if not dest or not re.match(r"\d+\.\d+\.\d+\.\d+", dest):
                    # Not a valid route line — skip
                    continue

                route = {
                    "destination": dest,
                    "next_hop":    next_hop,
                    "hop_count":   int(hcnt_s) if hcnt_s.isdigit() else 0,
                    "state":       state,
                    "dest_seqno":  seqno_s if seqno_s else "-",
                    "lifetime":    int(expire_s) if expire_s.lstrip("-").isdigit() else 0,
                    "flags":       flags,
                    "interface":   iface,
                    "precursors":  [],
                }
                if prec_str:
                    # First precursor on this line
                    prec_ip = prec_str.split()[0] if prec_str.split() else ""
                    if prec_ip and re.match(r"\d+\.\d+\.\d+\.\d+", prec_ip):
                        route["precursors"].append(prec_ip)

                result["routes"].append(route)
                current_route = route
                continue
            except (ValueError, IndexError):
                pass  # Fall through to split-based parsing

        # --- Fallback: split-based parsing ---
        parts = stripped.split()
        if len(parts) < 6:
            continue

        try:
            # With empty flags, split() gives fewer columns.
            # Detect by checking if parts look like: dest next hc st seq exp [flags] iface [prec...]
            # Flags field is alphabetic (U/R/I/G or "---") vs iface which starts with v/lo/eth
            # We scan from parts[6] onward to find the interface name
            dest      = parts[0]
            next_hop  = parts[1]
            hop_count = int(parts[2])
            state     = parts[3]
            dest_seq  = parts[4]
            lifetime  = int(parts[5])

            # Remaining parts after the first 6 fixed fields
            rest = parts[6:]

            flags = ""
            iface = ""
            precursors = []

            # Heuristic: scan rest[] to classify each token
            # - A token that looks like an interface name (starts with letter, not an IP)
            # - A token that matches IP pattern → precursor
            # - A token like "---", "U", "R", "UR", etc. → flags
            iface_found = False
            for token in rest:
                if re.match(r"\d+\.\d+\.\d+\.\d+$", token):
                    # IP address → precursor
                    precursors.append(token)
                elif not iface_found and re.match(r"^[a-zA-Z]", token):
                    # First alphabetic non-IP token
                    # Could be flags (U, R, UR, URI) or iface (vAB0s, eth0)
                    # Flags are typically short uppercase: U, R, UR, URI, G, ---
                    if re.match(r"^[URIGurg\-]{1,5}$", token):
                        flags = token
                    else:
                        iface = token
                        iface_found = True
                elif iface_found:
                    # After iface, remaining tokens are precursors
                    if re.match(r"\d+\.\d+\.\d+\.\d+$", token):
                        precursors.append(token)
                else:
                    # Unknown token after flags — likely iface
                    iface = token
                    iface_found = True

            route = {
                "destination": dest,
                "next_hop":    next_hop,
                "hop_count":   hop_count,
                "state":       state,
                "dest_seqno":  dest_seq,
                "lifetime":    lifetime,
                "flags":       flags,
                "interface":   iface,
                "precursors":  precursors,
            }
            result["routes"].append(route)
            current_route = route
        except (ValueError, IndexError):
            continue

    return result


@app.route("/api/routing/aodv", methods=["GET"])
def get_aodv_routing():
    """
    Return parsed AODV routing tables from /var/log/aodvd.rtlog
    for all nodes (or one via ?ns=ns-A).
    """
    target = request.args.get("ns")
    nodes  = [target] if target else list(topology["nodes"].keys())
    tables = {}
    for ns in nodes:
        tables[ns] = _parse_aodv_rtlog(ns)
    return jsonify(tables)


# ---------------------------------------------------------------------------
# REST API — ping
# ---------------------------------------------------------------------------

@app.route("/api/ping", methods=["POST"])
def do_ping():
    """
    Run ping from src namespace to a destination IP.
    Log output is streamed per-namespace to the correct frontend tab.

    Body: { "src": "ns-A", "dst": "10.0.1.2", "count": 5 }
    """
    data  = request.get_json(force=True) or {}
    src   = data.get("src", "")
    dst   = data.get("dst", "")
    count = max(1, min(int(data.get("count", 5)), 100))

    if not src or src not in topology["nodes"]:
        return jsonify({"ok": False, "error": "Invalid src namespace"}), 400
    if not dst:
        return jsonify({"ok": False, "error": "dst IP is required"}), 400

    emit_log(f"ping -c {count} {dst}", "info", src)

    def _run():
        out, err, rc = run_cmd(f"ping -c {count} -W 2 {dst}", netns=src)
        
        # Lấy toàn bộ log từ stdout (vì ping thông báo loss vào stdout)
        text = out if out.strip() else err
        
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            level = "error" if ("unreachable" in line.lower() or "100%" in line) else "info"
            socketio.emit("log", {"ns": src, "level": level, "msg": line})
            
        if rc != 0 and not text.strip():
            socketio.emit("log", {"ns": src, "level": "error", "msg": f"Ping failed with rc={rc}"})

    socketio.start_background_task(target=_run)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# REST API — cleanup
# ---------------------------------------------------------------------------

@app.route("/api/cleanup", methods=["POST"])
def cleanup():
    """Teardown everything: stop daemons, delete all namespaces."""
    emit_log("Full cleanup initiated.", "warn", "system")

    for ns in list(aodvd_procs.keys()):
        _stop_aodvd(ns)

    for ns in list(topology["nodes"].keys()):
        _delete_namespace(ns)
        # Clean up per-namespace rtlog files
        rtlog_path = f"/tmp/aodvd-{ns}.rtlog"
        try:
            os.remove(rtlog_path)
        except OSError:
            pass

    topology["nodes"].clear()
    topology["links"].clear()

    emit_log("Cleanup complete.", "info", "system")
    socketio.emit("topology_update", _build_topology_event())
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    # Push full topology state to the newly connected client immediately
    emit("topology_update", _build_topology_event())
    emit("log", {"ns": "system", "level": "info",
                 "msg": "Connected to AODV-UU dashboard backend."})


@socketio.on("disconnect")
def on_disconnect():
    pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("  AODV-UU Dashboard Backend  (free topology mode)")
    print("  Run with: sudo python app.py")
    print("  Open:     http://localhost:5000")
    print("=" * 60)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)