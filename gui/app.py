import os
import subprocess
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='static')
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def run_cmd(cmd):
    try:
        result = subprocess.run(cmd, shell=True, cwd=BASE_DIR, 
                              capture_output=True, text=True)
        return {"success": result.returncode == 0, "output": result.stdout, "error": result.stderr}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('static', path)

@app.route('/api/action/<action>', methods=['POST'])
def perform_action(action):
    if action == 'topology':
        res = run_cmd("sudo ./scripts/setup.sh topology")
    elif action == 'nfqueue':
        res = run_cmd("sudo ./scripts/setup.sh nfqueue")
    elif action == 'cleanup':
        run_cmd("sudo pkill -f aodvd")
        run_cmd("sudo pkill -f tcpdump")
        run_cmd("sudo pkill -f iperf3")
        res = run_cmd("sudo ./scripts/setup.sh cleanup")
    elif action == 'start_aodv':
        run_cmd("sudo pkill -f aodvd")
        # Sử dụng cờ -d (daemon mode) của aodvd để chạy nền an toàn
        run_cmd("sudo ip netns exec ns-A ./aodvd -d -l -i veth-AB-a")
        run_cmd("sudo ip netns exec ns-B ./aodvd -d -l -i veth-AB-b,veth-BC-b")
        run_cmd("sudo ip netns exec ns-C ./aodvd -d -l -i veth-BC-c")
        res = {"success": True, "output": "AODV daemons started in background."}
    elif action == 'stop_aodv':
        res = run_cmd("sudo pkill -f aodvd")
        res['output'] = "AODV daemons stopped."
    elif action == 'ping':
        res = run_cmd("sudo ip netns exec ns-A ping -c 3 10.0.2.2")
    else:
        return jsonify({"success": False, "error": "Unknown action"})
    
    return jsonify(res)

@app.route('/api/status', methods=['GET'])
def get_status():
    # Check if aodvd is running
    aodv_ps = run_cmd("ps -ef | grep aodvd | grep -v grep")
    aodv_running = len(aodv_ps['output'].strip()) > 0
    
    # Get routing tables
    routes = {}
    for ns in ['ns-A', 'ns-B', 'ns-C']:
        rt = run_cmd(f"sudo ip netns exec {ns} ip route")
        if rt['success']:
            routes[ns] = rt['output'].strip() or "No routes"
        else:
            routes[ns] = "Namespace offline or error"
            
    # Check if namespaces exist
    ns_list = run_cmd("ip netns list")
    topology_active = "ns-A" in ns_list['output']

    return jsonify({
        "topology_active": topology_active,
        "aodv_running": aodv_running,
        "routes": routes
    })

if __name__ == '__main__':
    # Run server on all interfaces
    app.run(host='0.0.0.0', port=5000, debug=True)
