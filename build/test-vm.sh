#!/bin/bash
set -euo pipefail

# LLM OS Micro — QEMU VM smoke test
#
# Usage:
#   ./build/test-vm.sh [path-to-qcow2]
#
# Default: build/output/llmos-0.2.2-micro.qcow2
#
# Requires: qemu-system-x86_64 in PATH
#
# Tests:
#   1. VM boots (serial console responds)
#   2. Node.js is available
#   3. LLM OS server starts
#   4. HTTP health check responds

IMAGE="${1:-build/output/llmos-0.2.2-micro.qcow2}"
SSH_PORT=2222
HTTP_PORT=3001
TIMEOUT=60
PASS=0
FAIL=0
VM_PID=""

cleanup() {
    echo ""
    if [ -n "$VM_PID" ] && kill -0 "$VM_PID" 2>/dev/null; then
        echo "[cleanup] Stopping VM (pid $VM_PID)..."
        kill "$VM_PID" 2>/dev/null || true
        wait "$VM_PID" 2>/dev/null || true
    fi
    echo ""
    echo "═══════════════════════════════"
    echo "  Results: $PASS passed, $FAIL failed"
    echo "═══════════════════════════════"
    [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

# --- Preflight ---
if [ ! -f "$IMAGE" ]; then
    echo "Image not found: $IMAGE"
    echo "Run the Buildroot build first, or pass the path as argument."
    exit 2
fi

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
    echo "qemu-system-x86_64 not found in PATH"
    echo "Install QEMU: winget install QEMU"
    exit 2
fi

echo "╔══════════════════════════════════════╗"
echo "║   LLM OS Micro — VM Smoke Test      ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Image: $IMAGE"
echo "  SSH:   localhost:$SSH_PORT"
echo "  HTTP:  localhost:$HTTP_PORT"
echo ""

# --- Create a temporary overlay so we don't modify the original image ---
OVERLAY=$(mktemp -u --suffix=.qcow2)
qemu-img create -f qcow2 -b "$(realpath "$IMAGE")" -F qcow2 "$OVERLAY" >/dev/null 2>&1

# --- Boot VM ---
echo "[boot] Starting QEMU..."
qemu-system-x86_64 \
    -m 512 \
    -smp 2 \
    -nographic \
    -drive file="$OVERLAY",format=qcow2,if=virtio \
    -netdev user,id=net0,hostfwd=tcp::${SSH_PORT}-:22,hostfwd=tcp::${HTTP_PORT}-:3000 \
    -device virtio-net-pci,netdev=net0 \
    -serial mon:stdio \
    > /tmp/llmos-vm-console.log 2>&1 &
VM_PID=$!

# --- Wait for SSH ---
echo "[wait] Waiting for SSH (up to ${TIMEOUT}s)..."
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 -o LogLevel=ERROR"
SSH_CMD="ssh $SSH_OPTS -p $SSH_PORT root@localhost"
READY=false

for i in $(seq 1 $((TIMEOUT / 2))); do
    if $SSH_CMD echo "ssh-ok" 2>/dev/null | grep -q "ssh-ok"; then
        READY=true
        break
    fi
    sleep 2
done

if [ "$READY" = false ]; then
    fail "VM did not respond to SSH within ${TIMEOUT}s"
    echo ""
    echo "[console] Last 20 lines of VM console:"
    tail -20 /tmp/llmos-vm-console.log 2>/dev/null || true
    exit 1
fi
pass "VM booted and SSH is available"

# --- Test: Node.js ---
echo ""
echo "[test] Checking Node.js..."
NODE_VER=$($SSH_CMD "node --version" 2>/dev/null || echo "FAIL")
if echo "$NODE_VER" | grep -q "^v"; then
    pass "Node.js $NODE_VER"
else
    fail "Node.js not available"
fi

# --- Test: LLM OS files ---
echo "[test] Checking LLM OS installation..."
if $SSH_CMD "test -f /opt/llm-os/src/server.js" 2>/dev/null; then
    pass "server.js exists at /opt/llm-os/src/server.js"
else
    fail "server.js not found"
fi

if $SSH_CMD "test -f /opt/llm-os/src/kernel/gateway.js" 2>/dev/null; then
    pass "Kernel modules present"
else
    fail "Kernel modules missing"
fi

# --- Test: Start server ---
echo "[test] Starting LLM OS server..."
$SSH_CMD "cd /opt/llm-os && OLLAMA_URL=http://localhost:11434 node src/server.js &" 2>/dev/null
sleep 3

# --- Test: HTTP health ---
echo "[test] Checking HTTP health..."
HEALTH=$(curl -s --connect-timeout 5 "http://localhost:${HTTP_PORT}/api/health" 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -qi "ok\|healthy\|status"; then
    pass "HTTP /api/health responds"
else
    # Try basic GET on root
    ROOT=$(curl -s --connect-timeout 5 "http://localhost:${HTTP_PORT}/" 2>/dev/null || echo "FAIL")
    if echo "$ROOT" | grep -qi "llm\|html\|shell"; then
        pass "HTTP root serves content"
    else
        fail "HTTP not responding (health: '$HEALTH')"
    fi
fi

# --- Test: Static analyzer module ---
echo "[test] Checking static analyzer..."
ANALYZER=$($SSH_CMD "node -e \"const a = require('/opt/llm-os/src/kernel/analyzer.js'); console.log(typeof a.analyze)\"" 2>/dev/null || echo "FAIL")
if [ "$ANALYZER" = "function" ]; then
    pass "Static analyzer module loads"
else
    fail "Static analyzer failed to load"
fi

# --- Test: Capability module ---
echo "[test] Checking capabilities module..."
CAPS=$($SSH_CMD "node -e \"const c = require('/opt/llm-os/src/kernel/capabilities.js'); console.log(typeof c.grantCapabilities)\"" 2>/dev/null || echo "FAIL")
if [ "$CAPS" = "function" ]; then
    pass "Capabilities module loads"
else
    fail "Capabilities module failed to load"
fi

# cleanup runs via trap
