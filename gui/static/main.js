/**
 * main.js — AODV-UU Network Dashboard
 *
 * Responsibilities:
 *  1. vis-network graph — fully dynamic, nodes/edges added/removed at runtime
 *  2. Free topology — drag to connect any two nodes (EdgeMode), right-click to delete
 *  3. WebSocket (Socket.IO) — per-namespace log tabs, auto-created when node appears
 *  4. Routing table cards — generated dynamically from /api/routing response
 *  5. Status panel — derived from topology_update events, no polling
 */

// ---------------------------------------------------------------------------
// Socket.IO connection
// ---------------------------------------------------------------------------

const socket = io();   // connects to the server that served this page

// ---------------------------------------------------------------------------
// vis-network setup
// ---------------------------------------------------------------------------

/** @type {vis.Network|null} */
let network = null;
const visNodes = new vis.DataSet();
const visEdges = new vis.DataSet();

// Map: namespace name → vis node id (we use the ns name as the id directly)
// Map: link id (backend) → vis edge id

const NODE_STYLE = {
  shape: "box",
  margin: 14,
  borderWidth: 2,
  font: { color: "#ffffff", size: 13, face: "monospace" },
  color: { background: "#1c1c1e", border: "#0071e3", highlight: { background: "#2c2c2e", border: "#3a9eff" } },
};

const EDGE_STYLE_UP   = { color: { color: "#0066cc", highlight: "#3a9eff" }, width: 2, length: 220 };
const EDGE_STYLE_DOWN = { color: { color: "#ff3b30", highlight: "#ff6b60" }, width: 2, dashes: [6, 4], length: 220 };

function initGraph() {
  const container = document.getElementById("topology-canvas");
  if (!container) return;

  const options = {
    physics: {
      stabilization: { iterations: 80 },
      barnesHut: { springLength: 200, springConstant: 0.04 },
    },
    edges: {
      font: { color: "#aaaaaa", strokeWidth: 0, size: 11 },
      smooth: { type: "dynamic" },
    },
    interaction: {
      zoomView: true,
      hover: true,
      multiselect: false,
    },
    manipulation: {
      enabled: false,   // toggled programmatically via "Add Link" mode
      addEdge(edgeData, callback) {
        const src = visNodes.get(edgeData.from)?.ns;
        const dst = visNodes.get(edgeData.to)?.ns;
        if (!src || !dst || src === dst) { callback(null); return; }
        callback(null);            // don't add vis edge yet — let backend confirm
        apiAddLink(src, dst);
        disableEdgeMode();
      },
    },
  };

  network = new vis.Network(
    container,
    { nodes: visNodes, edges: visEdges },
    options,
  );

  // Right-click on a node → delete it
  network.on("oncontext", (params) => {
    params.event.preventDefault();
    const nodeId = network.getNodeAt(params.pointer.DOM);
    const edgeId = network.getEdgeAt(params.pointer.DOM);
    if (nodeId != null) {
      const ns = visNodes.get(nodeId)?.ns;
      if (ns && confirm(`Delete node ${ns} and all its links?`)) apiDeleteNode(ns);
    } else if (edgeId != null) {
      const linkId = visEdges.get(edgeId)?.linkId;
      if (linkId && confirm(`Delete link ${linkId}?`)) apiDeleteLink(linkId);
    }
  });

  // Click on an edge → show toggle option
  network.on("selectEdge", (params) => {
    if (params.edges.length !== 1) return;
    const edge  = visEdges.get(params.edges[0]);
    if (!edge?.linkId) return;
    const label = edge.linkUp ? "Bring DOWN (simulate failure)" : "Bring UP (restore)";
    if (confirm(`${edge.linkId}\n\n${label}?`)) apiToggleLink(edge.linkId);
    network.unselectAll();
  });
}

// ---------------------------------------------------------------------------
// Graph sync from topology_update event
// ---------------------------------------------------------------------------

/**
 * Called whenever the backend pushes a topology_update event.
 * Reconciles the vis DataSets with the backend state — adds/removes/updates
 * nodes and edges without destroying the entire graph.
 *
 * @param {{ nodes: Array, links: Array }} data
 */
function syncGraph(data) {
  const { nodes: backendNodes, links: backendLinks } = data;

  // --- Nodes ---
  const backendNodeIds = new Set(backendNodes.map(n => n.name));

  // Remove stale vis nodes
  visNodes.getIds().forEach(id => {
    if (!backendNodeIds.has(id)) visNodes.remove(id);
  });

  // Upsert nodes
  backendNodes.forEach(n => {
    const ipLabel = n.ips && n.ips.length ? "\n" + n.ips.join("\n") : "";
    const aodvColor = n.aodvd ? "#30d158" : "#636366";
    const item = {
      id:    n.name,
      ns:    n.name,
      label: `${n.name}${ipLabel}`,
      title: `aodvd: ${n.aodvd ? "running" : "stopped"}`,
      ...NODE_STYLE,
      color: {
        ...NODE_STYLE.color,
        border: n.aodvd ? "#30d158" : "#0071e3",
      },
    };
    visNodes.get(n.name) ? visNodes.update(item) : visNodes.add(item);
  });

  // --- Edges ---
  const backendLinkIds = new Set(backendLinks.map(l => l.id));

  // Remove stale vis edges
  visEdges.getIds().forEach(id => {
    if (!backendLinkIds.has(visEdges.get(id)?.linkId)) visEdges.remove(id);
  });

  // Upsert edges
  backendLinks.forEach(l => {
    const style   = l.up ? EDGE_STYLE_UP : EDGE_STYLE_DOWN;
    const edgeId  = `edge-${l.id}`;
    const item    = {
      id:     edgeId,
      from:   l.src,
      to:     l.dst,
      linkId: l.id,
      linkUp: l.up,
      label:  `${l.ip_src}↔${l.ip_dst}`,
      ...style,
    };
    visEdges.get(edgeId) ? visEdges.update(item) : visEdges.add(item);
  });

  // Sync status panel
  syncStatusPanel(data);
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------

function syncStatusPanel(data) {
  const { nodes } = data;
  const anyAlive  = nodes.some(n => n.alive);
  const anyAodvd  = nodes.some(n => n.aodvd);

  setStatusEl("status-topology", anyAlive,  "Online",  "Offline");
  setStatusEl("status-aodv",     anyAodvd,  "Running", "Offline");
  
  syncNFQueueBtn(data.nfqueue_enabled);
}

function setStatusEl(id, active, onLabel, offLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = active
    ? `${onLabel} <span class="status-indicator active"></span>`
    : `${offLabel} <span class="status-indicator"></span>`;
}

function syncNFQueueBtn(enabled) {
  const nfqBtn = document.getElementById("btn-nfqueue");
  if (!nfqBtn) return;
  if (enabled) {
    nfqBtn.innerHTML = "⚙ NFQUEUE: <strong>ON</strong>";
    nfqBtn.className = "btn btn-ghost active";
  } else {
    nfqBtn.innerHTML = "⚙ NFQUEUE: OFF";
    nfqBtn.className = "btn btn-ghost";
  }
}

// ---------------------------------------------------------------------------
// "Add Link" edge-draw mode
// ---------------------------------------------------------------------------

let edgeModeActive = false;

function enableEdgeMode() {
  if (!network) return;
  edgeModeActive = true;
  network.addEdgeMode();
  document.getElementById("btn-add-link")?.classList.add("active");
  logSystem("Click source node, then destination node to create a link.");
}

function disableEdgeMode() {
  if (!network) return;
  edgeModeActive = false;
  network.disableEditMode();
  document.getElementById("btn-add-link")?.classList.remove("active");
}

function toggleEdgeMode() {
  edgeModeActive ? disableEdgeMode() : enableEdgeMode();
}

// ---------------------------------------------------------------------------
// Per-namespace WebSocket log tabs
// ---------------------------------------------------------------------------

/**
 * Tab state:
 *   logTabs[ns] = { tab: <button>, panel: <pre>, lines: number }
 */
const logTabs = {};
let activeTab = "system";

function ensureTab(ns) {
  if (logTabs[ns]) return;

  const tabBar   = document.getElementById("log-tab-bar");
  const tabPanes = document.getElementById("log-tab-panes");
  if (!tabBar || !tabPanes) return;

  // Tab button
  const btn = document.createElement("button");
  btn.className   = "log-tab";
  btn.textContent = ns;
  btn.dataset.ns  = ns;
  btn.onclick     = () => switchTab(ns);
  tabBar.appendChild(btn);

  // Tab panel
  const pre = document.createElement("pre");
  pre.id        = `log-pane-${ns}`;
  pre.className = "log-pane";
  pre.style.display = "none";
  tabPanes.appendChild(pre);

  logTabs[ns] = { tab: btn, panel: pre, lines: 0 };

  // Switch to the first real tab automatically
  if (Object.keys(logTabs).length === 1) switchTab(ns);
}

function switchTab(ns) {
  activeTab = ns;
  Object.entries(logTabs).forEach(([n, { tab, panel }]) => {
    const active = n === ns;
    tab.classList.toggle("active", active);
    panel.style.display = active ? "block" : "none";
    if (active) tab.classList.remove("unread");  // clear badge
  });
}

function appendLog(ns, msg, level) {
  ensureTab(ns);
  const { panel, tab } = logTabs[ns];

  const line = document.createElement("span");
  line.className = `log-line log-${level}`;
  line.textContent = `[${timestamp()}] ${msg}\n`;
  panel.appendChild(line);
  logTabs[ns].lines++;

  // Auto-scroll only if this tab is active
  if (ns === activeTab) {
    panel.scrollTop = panel.scrollHeight;
  } else {
    // Badge unread indicator on inactive tab
    tab.classList.add("unread");
  }

  // Keep memory reasonable — drop oldest lines when over 500
  if (logTabs[ns].lines > 500) {
    panel.removeChild(panel.firstChild);
    logTabs[ns].lines--;
  }
}

function logSystem(msg, level = "info") {
  appendLog("system", msg, level);
}

function timestamp() {
  return new Date().toTimeString().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Routing table cards — tabbed (AODV Routes + Kernel Routes)
// ---------------------------------------------------------------------------

// Track previous AODV route destinations per node to detect new routes
const _prevAodvDests = {};   // { "ns-A": Set(["10.0.1.2", ...]) }
let _aodvData = {};          // latest AODV route data from /api/routing/aodv
let _kernelData = {};        // latest kernel route data from /api/routing
const _cardActiveTab = {};   // { "ns-A": "aodv" | "kernel" }  — remembers tab per card

async function refreshRoutingTables() {
  try {
    const [kernelRes, aodvRes] = await Promise.all([
      fetch("/api/routing"),
      fetch("/api/routing/aodv"),
    ]);
    _kernelData = await kernelRes.json();
    _aodvData   = await aodvRes.json();
    renderRoutingCards();
  } catch (e) {
    logSystem(`Routing fetch error: ${e}`, "error");
  }
}

function renderRoutingCards() {
  const grid = document.getElementById("routing-grid");
  if (!grid) return;

  // Merge keys from both kernel and aodv data
  const nsKeys = [...new Set([
    ...Object.keys(_kernelData),
    ...Object.keys(_aodvData),
  ])];

  // Remove placeholder paragraphs
  grid.querySelectorAll("p").forEach(p => p.remove());

  // Remove cards for nodes that no longer exist
  grid.querySelectorAll(".card[data-ns]").forEach(card => {
    if (!nsKeys.includes(card.dataset.ns)) card.remove();
  });

  nsKeys.forEach(ns => {
    const kEntry = _kernelData[ns] || {};
    const aEntry = _aodvData[ns]   || {};

    const routes = typeof kEntry === "object" ? (kEntry.routes || "") : String(kEntry);
    const error  = typeof kEntry === "object" ? (kEntry.error  || "") : "";
    const ips    = typeof kEntry === "object" ? (kEntry.ips    || []) : [];
    const nfq    = typeof kEntry === "object" ? kEntry.nfqueue_active : false;
    const aodvd  = typeof kEntry === "object" ? kEntry.aodvd_running  : false;
    const ifaces = typeof kEntry === "object" ? (kEntry.ifaces || []) : [];

    const aodvRoutes = aEntry.routes || [];
    const aodvTs     = aEntry.timestamp || "";
    const validCount   = aodvRoutes.filter(r => r.state === "VAL").length;
    const invalidCount = aodvRoutes.filter(r => r.state !== "VAL").length;

    // Detect newly added routes
    const prevDests = _prevAodvDests[ns] || new Set();
    const currDests = new Set(aodvRoutes.map(r => r.destination));
    const newDests  = new Set([...currDests].filter(d => !prevDests.has(d)));
    _prevAodvDests[ns] = currDests;

    // Remember which tab is active
    if (!_cardActiveTab[ns]) _cardActiveTab[ns] = "aodv";
    const activeTab = _cardActiveTab[ns];

    let card = grid.querySelector(`.card[data-ns="${ns}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className  = "card";
      card.dataset.ns = ns;
      grid.appendChild(card);
    }

    // Status badges
    const aodvBadge = aodvd
      ? `<span style="color:#30d158;font-size:10px">● aodvd</span>`
      : `<span style="color:#636366;font-size:10px">○ aodvd</span>`;
    const nfqBadge = nfq
      ? `<span style="color:#0071e3;font-size:10px">● NFQUEUE</span>`
      : `<span style="color:#ff3b30;font-size:10px">○ NFQUEUE</span>`;

    // Route count badges
    const validBadge   = validCount > 0
      ? `<span class="route-badge valid-badge">✓ ${validCount}</span>` : "";
    const invalidBadge = invalidCount > 0
      ? `<span class="route-badge invalid-badge">✕ ${invalidCount}</span>` : "";

    // Interface list
    const ifaceStr = ifaces.length ? ifaces.join("  ") : "no interfaces";

    // ── AODV Routes table ──
    let aodvHtml;
    if (aodvRoutes.length === 0) {
      aodvHtml = `<div class="aodv-empty">
        ${aodvd ? "No AODV routes yet — trigger traffic to discover routes" : "Start aodvd to see AODV routes"}
        ${aodvTs ? `<br><span style="font-size:10px;opacity:.5">last dump: ${aodvTs}</span>` : ""}
      </div>`;
    } else {
      aodvHtml = `
        ${aodvTs ? `<div style="font-size:9.5px;color:var(--muted);margin-bottom:6px">Last dump: ${aodvTs}</div>` : ""}
        <div style="overflow-x:auto">
        <table class="aodv-table">
          <thead><tr>
            <th>Dest</th><th>Next Hop</th><th>HC</th>
            <th>Seq#</th><th>State</th><th>Lifetime</th>
            <th>Iface</th><th>Precursors</th>
          </tr></thead>
          <tbody>
            ${aodvRoutes.map(r => {
              const isInvalid = r.state !== "VAL";
              const isNew = newDests.has(r.destination);
              const cls = isInvalid ? "route-invalid" : (isNew ? "route-new" : "");
              const stateHtml = isInvalid
                ? `<span class="state-val invalid">${r.state}</span>`
                : `<span class="state-val valid">${r.state}</span>`;
              const lifetime = r.lifetime > 0 ? `${r.lifetime}ms` : "—";
              const prec = r.precursors.length ? r.precursors.join(", ") : "—";
              return `<tr class="${cls}">
                <td>${r.destination}</td>
                <td>${r.next_hop}</td>
                <td>${r.hop_count}</td>
                <td>${r.dest_seqno}</td>
                <td>${stateHtml}</td>
                <td>${lifetime}</td>
                <td>${r.interface}</td>
                <td>${prec}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
        </div>`;
    }

    // ── Kernel routes ──
    const routeLines = routes
      ? routes.split("\n").map(line => {
          const color = line.includes("via") ? "#30d158" : "#8e8e93";
          return '<span style="color:' + color + '">' + line + '</span>';
        }).join("\n")
      : '<span style="color:#636366">' + (error || "No routes yet") + '</span>';

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
        <h3 class="card-title">${ns}</h3>
        <div style="display:flex;gap:8px;margin-top:4px">${aodvBadge} ${nfqBadge}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <p class="caption" style="margin:0">
          ${ips.length ? ips.join(" | ") : "no IPs yet"}
        </p>
        ${validBadge}${invalidBadge}
      </div>
      <p class="caption" style="margin-bottom:10px;font-size:10px;opacity:.6">
        ${ifaceStr}
      </p>
      <div class="rt-tabs">
        <button class="rt-tab ${activeTab === 'aodv' ? 'active' : ''}" data-tab="aodv" data-ns="${ns}">AODV Routes</button>
        <button class="rt-tab ${activeTab === 'kernel' ? 'active' : ''}" data-tab="kernel" data-ns="${ns}">Kernel Routes</button>
      </div>
      <div class="rt-pane ${activeTab === 'aodv' ? 'active' : ''}" data-pane="aodv">${aodvHtml}</div>
      <div class="rt-pane ${activeTab === 'kernel' ? 'active' : ''}" data-pane="kernel">
        <div class="code-block" style="font-size:11px">${routeLines}</div>
      </div>
    `;

    // Wire tab switching
    card.querySelectorAll(".rt-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        const t = tab.dataset.tab;
        _cardActiveTab[ns] = t;
        card.querySelectorAll(".rt-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
        card.querySelectorAll(".rt-pane").forEach(p => p.classList.toggle("active", p.dataset.pane === t));
      });
    });
  });

  if (nsKeys.length === 0) {
    grid.innerHTML = `<p style="color:#888;grid-column:1/-1">No nodes yet. Add nodes and links first.</p>`;
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function apiFetch(url, method = "POST", body = null) {
  try {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    return await res.json();
  } catch (e) {
    logSystem(`API error (${url}): ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

async function apiAddNode() {
  const name = document.getElementById("input-node-name")?.value.trim();
  const body = name ? { name } : {};
  const data = await apiFetch("/api/node", "POST", body);
  if (!data.ok) logSystem(`Add node failed: ${data.error}`, "error");
}

async function apiDeleteNode(ns) {
  const data = await apiFetch(`/api/node/${ns}`, "DELETE");
  if (!data.ok) logSystem(`Delete node failed: ${data.error}`, "error");
}

async function apiAddLink(src, dst) {
  const data = await apiFetch("/api/link", "POST", { src, dst });
  if (!data.ok) logSystem(`Add link failed: ${data.error}`, "error");
}

async function apiDeleteLink(linkId) {
  const data = await apiFetch(`/api/link/${encodeURIComponent(linkId)}`, "DELETE");
  if (!data.ok) logSystem(`Delete link failed: ${data.error}`, "error");
}

async function apiToggleLink(linkId) {
  const data = await apiFetch(`/api/link/${encodeURIComponent(linkId)}/toggle`);
  if (!data.ok) logSystem(`Toggle link failed: ${data.error}`, "error");
}

async function apiToggleNFQueue() {
  const data = await apiFetch("/api/nfqueue/toggle");
  if (!data.ok) logSystem(`NFQUEUE toggle failed: ${data.error}`, "error");
}

async function apiStartAodv(ns = null) {
  const url  = ns ? `/api/aodv/start?ns=${ns}` : "/api/aodv/start";
  const data = await apiFetch(url);
  if (!data.ok) logSystem("Start aodvd failed.", "error");
}

async function apiStopAodv(ns = null) {
  const url  = ns ? `/api/aodv/stop?ns=${ns}` : "/api/aodv/stop";
  const data = await apiFetch(url);
  if (!data.ok) logSystem("Stop aodvd failed.", "error");
}

async function apiPing() {
  const src   = document.getElementById("ping-src")?.value.trim();
  const dst   = document.getElementById("ping-dst")?.value.trim();
  const count = parseInt(document.getElementById("ping-count")?.value || "5", 10);
  if (!src || !dst) { logSystem("Ping: fill in src and dst.", "warn"); return; }
  const data  = await apiFetch("/api/ping", "POST", { src, dst, count });
  if (!data.ok) logSystem(`Ping failed: ${data.error}`, "error");
  else ensureTab(src);   // make sure the src tab is ready to receive ping output
}

async function apiCleanup() {
  // Use a custom in-page confirmation instead of browser confirm()
  // which may be blocked in some browser contexts
  const btn = document.getElementById("btn-cleanup");
  if (!btn) return;

  if (btn.dataset.confirming !== "1") {
    btn.dataset.confirming = "1";
    btn.textContent = "✕ Click again to confirm";
    btn.style.background = "rgba(255,59,48,0.2)";
    setTimeout(() => {
      btn.dataset.confirming = "";
      btn.textContent = "✕ Cleanup All";
      btn.style.background = "";
    }, 3000);
    return;
  }

  // Second click — proceed
  btn.dataset.confirming = "";
  btn.textContent = "✕ Cleanup All";
  btn.style.background = "";

  const data = await apiFetch("/api/cleanup");
  if (!data.ok) logSystem("Cleanup failed.", "error");
  else logSystem("Cleanup complete.", "info");
}

// ---------------------------------------------------------------------------
// Socket.IO event handlers
// ---------------------------------------------------------------------------

socket.on("connect", () => {
  logSystem("WebSocket connected.", "info");
});

socket.on("disconnect", () => {
  logSystem("WebSocket disconnected.", "warn");
});

/**
 * topology_update — backend pushes this on every state change.
 * Used to sync graph, status panel, and trigger routing table refresh.
 */
socket.on("topology_update", (data) => {
  syncGraph(data);
  refreshRoutingTables();
});

/**
 * log — streamed aodvd output and system events.
 * Each message carries an `ns` field so we can route it to the right tab.
 */
socket.on("log", ({ ns, level, msg }) => {
  appendLog(ns || "system", msg, level || "info");
});

// ---------------------------------------------------------------------------
// AODV Event Timeline
// ---------------------------------------------------------------------------

let eventCount   = 0;
let eventPaused  = false;
const hiddenTypes = new Set();  // types toggled off by legend clicks

// Node color map — sync with vis-network node colors
const NODE_COLORS = [
  "#ff9f0a","#30d158","#0071e3","#ff3b30",
  "#bf5af2","#64d2ff","#ffd60a","#ff6961",
];
const nodeColorMap = {};
function nodeColor(ns) {
  if (!nodeColorMap[ns]) {
    const idx = Object.keys(nodeColorMap).length % NODE_COLORS.length;
    nodeColorMap[ns] = NODE_COLORS[idx];
  }
  return nodeColorMap[ns];
}

const TYPE_LABEL = {
  rreq_send:       "RREQ ↗",
  rreq_recv:       "RREQ ↙",
  rreq_forward:    "RREQ ⇒",
  rreq_dup:        "RREQ ✕ dup",
  rrep_send:       "RREP ↗",
  rrep_recv:       "RREP ↙",
  rrep_forward:    "RREP ⇒",
  rerr_send:       "RERR ↗",
  rerr_recv:       "RERR ↙",
  hello_send:      "HELLO ♡",
  route_add:       "ROUTE +",
  route_expire:    "ROUTE ✕",
  nfqueue_verdict: "NFQUEUE ✓",
};

function appendEvent(ev) {
  if (eventPaused) return;
  if (hiddenTypes.has(ev.type)) return;

  const feed = document.getElementById("event-feed");
  if (!feed) return;

  // Remove placeholder if present
  feed.querySelector(".placeholder")?.remove();

  const row = document.createElement("div");
  row.className = `ev-item ev-${ev.type}`;
  row.dataset.type = ev.type;

  const color = nodeColor(ev.node);
  const label = TYPE_LABEL[ev.type] || ev.type;

  row.innerHTML = `
    <span class="ev-ts">${ev.ts || ""}</span>
    <span class="ev-node" style="color:${color}">${ev.node}</span>
    <span class="ev-msg"><strong style="opacity:.6;font-size:10px;margin-right:6px">${label}</strong>${ev.msg}</span>
  `;

  feed.appendChild(row);
  feed.scrollTop = feed.scrollHeight;

  // Cap at 300 rows
  eventCount++;
  document.getElementById("event-count").textContent = `${eventCount} events`;
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
}

socket.on("aodv_event", (ev) => {
  appendEvent(ev);
});

// Wire legend toggle buttons
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".ev-legend").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.type;
      if (hiddenTypes.has(t)) {
        hiddenTypes.delete(t);
        btn.classList.remove("muted");
      } else {
        hiddenTypes.add(t);
        btn.classList.add("muted");
      }
    });
  });

  document.getElementById("btn-clear-events")?.addEventListener("click", () => {
    const feed = document.getElementById("event-feed");
    if (feed) {
      feed.innerHTML = `<p class="placeholder">Cleared. Waiting for events...</p>`;
      eventCount = 0;
      document.getElementById("event-count").textContent = "0 events";
    }
  });

  document.getElementById("btn-pause-events")?.addEventListener("click", function() {
    eventPaused = !eventPaused;
    this.textContent = eventPaused ? "▶ Resume" : "⏸ Pause";
    this.style.color = eventPaused ? "var(--accent2)" : "";
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // Always ensure the "system" tab exists first
  ensureTab("system");

  initGraph();

  // Wire up button onclick handlers defined in index.html
  // (keeps HTML clean — buttons only need id="btn-*")
  const bind = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);

  bind("btn-add-node",    apiAddNode);
  bind("btn-add-link",    toggleEdgeMode);
  bind("btn-nfqueue",     apiToggleNFQueue);
  bind("btn-start-aodv",  () => apiStartAodv());
  bind("btn-stop-aodv",   () => apiStopAodv());
  bind("btn-ping",        apiPing);
  bind("btn-refresh-rt",  refreshRoutingTables);
  bind("btn-cleanup",     apiCleanup);

  // Escape key exits edge-draw mode
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && edgeModeActive) disableEdgeMode();
  });
});