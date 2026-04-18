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
}

function setStatusEl(id, active, onLabel, offLabel) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = active
    ? `${onLabel} <span class="status-indicator active"></span>`
    : `${offLabel} <span class="status-indicator"></span>`;
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
// Routing table cards — fully dynamic
// ---------------------------------------------------------------------------

async function refreshRoutingTables() {
  try {
    const res  = await fetch("/api/routing");
    const data = await res.json();
    renderRoutingCards(data);
  } catch (e) {
    logSystem(`Routing fetch error: ${e}`, "error");
  }
}

function renderRoutingCards(tables) {
  const grid = document.getElementById("routing-grid");
  if (!grid) return;

  // Build a set of current ns keys in response
  const nsKeys = Object.keys(tables);

  // Remove cards for nodes that no longer exist
  grid.querySelectorAll(".card[data-ns]").forEach(card => {
    if (!nsKeys.includes(card.dataset.ns)) card.remove();
  });

  nsKeys.forEach(ns => {
    const { routes, error, ips } = tables[ns];

    let card = grid.querySelector(`.card[data-ns="${ns}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className  = "card";
      card.dataset.ns = ns;
      card.innerHTML  = `
        <h3 class="card-title">${ns}</h3>
        <p class="caption ns-ips"></p>
        <div class="code-block ns-routes"></div>
      `;
      grid.appendChild(card);
    }

    card.querySelector(".ns-ips").textContent    = ips.join(" | ") || "no IPs yet";
    card.querySelector(".ns-routes").textContent = routes || error || "No routes";
  });

  // Placeholder when no nodes exist
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

async function apiEnableNFQueue() {
  const data = await apiFetch("/api/nfqueue");
  if (!data.ok) logSystem("NFQUEUE setup failed.", "error");
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
  if (!confirm("This will destroy ALL namespaces and stop all daemons. Continue?")) return;
  const data = await apiFetch("/api/cleanup");
  if (!data.ok) logSystem("Cleanup failed.", "error");
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
  bind("btn-nfqueue",     apiEnableNFQueue);
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