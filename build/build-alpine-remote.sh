#!/bin/bash
set -euo pipefail

# Build the Alpine VM image remotely using Docker on the GPU machine.
# Run from Git Bash on Windows:
#   ./build/build-alpine-remote.sh
#
# Uses docker context 'gpu-machine' (configure with: docker context create gpu-machine --docker "host=tcp://YOUR_HOST:2375")
# Output: build/output/llmos-0.2.3-server.qcow2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTEXT="gpu-machine"

echo "╔══════════════════════════════════════╗"
echo "║   LLM OS Alpine VM Builder          ║"
echo "║   Remote: $CONTEXT                  ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Docker context is reachable
echo "[1/4] Checking Docker connection..."
if ! docker --context "$CONTEXT" info >/dev/null 2>&1; then
    echo "ERROR: Cannot reach Docker on $CONTEXT"
    echo "Check: docker --context gpu-machine info"
    exit 1
fi
echo "  Connected to $(docker --context "$CONTEXT" info --format '{{.Name}}')"

# Build the builder image
echo ""
echo "[2/4] Building llmos-builder image (this may take a few minutes)..."
cd "$REPO_DIR"
docker --context "$CONTEXT" build -f build/Dockerfile.iso -t llmos-builder .

# Run the builder (needs --privileged for loop devices)
echo ""
echo "[3/4] Building VM image (this may take several minutes)..."
docker --context "$CONTEXT" run --rm --privileged \
    --name llmos-vm-build \
    -v llmos-build-output:/output \
    llmos-builder

# Copy output back
echo ""
echo "[4/4] Copying build output..."
# Create a temp container to access the volume
CONTAINER_ID=$(docker --context "$CONTEXT" create -v llmos-build-output:/output alpine:3.21 true)

# Copy files from the volume
docker --context "$CONTEXT" cp "$CONTAINER_ID:/output/." "$REPO_DIR/build/output/"
docker --context "$CONTEXT" rm "$CONTAINER_ID" >/dev/null

# Cleanup the volume
docker --context "$CONTEXT" volume rm llmos-build-output >/dev/null 2>&1 || true

echo ""
echo "╔══════════════════════════════════════╗"
echo "║        Build complete!               ║"
echo "╚══════════════════════════════════════╝"
echo ""
ls -lh "$REPO_DIR/build/output/llmos-"*.qcow2 2>/dev/null || echo "(no qcow2 files found)"
echo ""
echo "Boot with: build/output/boot-alpine.bat"
echo "SSH: root / llmos"
