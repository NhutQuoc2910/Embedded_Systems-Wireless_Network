// Topology Graph Configuration
let network = null;

function initGraph() {
  const container = document.getElementById('topology-canvas');
  
  // Create nodes with Apple style (dark theme support)
  const nodes = new vis.DataSet([
    { id: 1, label: 'NS-A\n(10.0.1.1)', color: { background: '#272729', border: '#0071e3' }, font: { color: '#ffffff' }, shape: 'box', margin: 15, borderWidth: 2 },
    { id: 2, label: 'NS-B\n(Router)', color: { background: '#272729', border: '#0071e3' }, font: { color: '#ffffff' }, shape: 'box', margin: 15, borderWidth: 2 },
    { id: 3, label: 'NS-C\n(10.0.2.2)', color: { background: '#272729', border: '#0071e3' }, font: { color: '#ffffff' }, shape: 'box', margin: 15, borderWidth: 2 }
  ]);

  // Create edges
  const edges = new vis.DataSet([
    { from: 1, to: 2, label: 'veth-AB', color: { color: '#0066cc' }, width: 2, length: 250 },
    { from: 2, to: 3, label: 'veth-BC', color: { color: '#0066cc' }, width: 2, length: 250 }
  ]);

  const data = { nodes: nodes, edges: edges };
  const options = {
    physics: {
      stabilization: false,
      barnesHut: { springLength: 200 }
    },
    edges: {
      font: { color: '#ffffff', strokeWidth: 0, size: 14 }
    },
    interaction: { zoomView: false }
  };

  network = new vis.Network(container, data, options);
}

// API Interactions
async function triggerAction(action) {
  const logBlock = document.getElementById('log-output');
  logBlock.style.display = 'block';
  logBlock.innerText = `Executing ${action}...`;

  try {
    const response = await fetch(`/api/action/${action}`, { method: 'POST' });
    const data = await response.json();
    
    if (data.success) {
      logBlock.innerText = `Success:\n${data.output}`;
      logBlock.style.color = '#34c759'; // Success green
    } else {
      logBlock.innerText = `Error:\n${data.error || data.output}`;
      logBlock.style.color = '#ff3b30'; // Error red
    }
  } catch (err) {
    logBlock.innerText = `Network/API Error: ${err}`;
    logBlock.style.color = '#ff3b30';
  }
  
  refreshStatus();
}

async function refreshStatus() {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    
    // Update Indicators
    const topoInd = document.querySelector('#status-topology .status-indicator');
    const topoText = document.getElementById('status-topology');
    if (data.topology_active) {
      topoInd.classList.add('active');
      topoText.innerHTML = 'Online <span class="status-indicator active"></span>';
    } else {
      topoInd.classList.remove('active');
      topoText.innerHTML = 'Offline <span class="status-indicator"></span>';
    }

    const aodvInd = document.querySelector('#status-aodv .status-indicator');
    const aodvText = document.getElementById('status-aodv');
    if (data.aodv_running) {
      aodvInd.classList.add('active');
      aodvText.innerHTML = 'Running <span class="status-indicator active"></span>';
    } else {
      aodvInd.classList.remove('active');
      aodvText.innerHTML = 'Offline <span class="status-indicator"></span>';
    }

    // Update Routing Tables
    document.getElementById('rt-ns-A').innerText = data.routes['ns-A'] || 'No routes';
    document.getElementById('rt-ns-B').innerText = data.routes['ns-B'] || 'No routes';
    document.getElementById('rt-ns-C').innerText = data.routes['ns-C'] || 'No routes';
    
  } catch (err) {
    console.error("Status fetch failed", err);
  }
}

// Initial Setup
document.addEventListener('DOMContentLoaded', () => {
  initGraph();
  refreshStatus();
  
  // Auto-refresh tables every 3 seconds
  setInterval(refreshStatus, 3000);
});
