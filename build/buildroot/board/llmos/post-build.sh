#!/bin/bash
set -euo pipefail

# Buildroot post-build hook
# Runs after rootfs is built, before image creation.
# $1 = target directory (the rootfs being assembled)

TARGET_DIR="$1"
BOARD_DIR="$(dirname "$0")"

echo "[llmos] Post-build: installing Node.js and LLM OS..."

# --- Fetch Node.js static binary (musl) ---
NODE_VERSION="20.18.3"
NODE_ARCH="x64"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}-musl.tar.xz"
NODE_SHA256="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/SHASUMS256.txt"

NODE_DIR="${TARGET_DIR}/opt/llm-os/node"
mkdir -p "${NODE_DIR}"

if [ ! -f "${NODE_DIR}/bin/node" ]; then
    echo "  Downloading Node.js v${NODE_VERSION} (musl static)..."
    wget -qO- "${NODE_URL}" | tar -xJ -C "${NODE_DIR}" --strip-components=1

    # Verify binary works (in case of architecture mismatch)
    if [ -x "${NODE_DIR}/bin/node" ]; then
        echo "  Node.js installed: $(${NODE_DIR}/bin/node --version 2>/dev/null || echo 'cross-compiled, cannot verify')"
    fi
else
    echo "  Node.js already present, skipping download"
fi

# Symlinks
mkdir -p "${TARGET_DIR}/usr/local/bin"
ln -sf /opt/llm-os/node/bin/node "${TARGET_DIR}/usr/local/bin/node"
ln -sf /opt/llm-os/node/bin/npm "${TARGET_DIR}/usr/local/bin/npm"
ln -sf /opt/llm-os/node/bin/npx "${TARGET_DIR}/usr/local/bin/npx"

# --- Install LLM OS source ---
LLMOS_SRC="/llmos-src"
LLMOS_DEST="${TARGET_DIR}/opt/llm-os"

echo "  Copying LLM OS source..."
mkdir -p "${LLMOS_DEST}/data/storage"
mkdir -p "${LLMOS_DEST}/data/security-reports"

# Copy application source
cp -a "${LLMOS_SRC}/src" "${LLMOS_DEST}/"
cp -a "${LLMOS_SRC}/examples" "${LLMOS_DEST}/"
cp -a "${LLMOS_SRC}/package.json" "${LLMOS_DEST}/"

# Copy registry if it exists
[ -d "${LLMOS_SRC}/registry" ] && cp -a "${LLMOS_SRC}/registry" "${LLMOS_DEST}/"

# Create .env from example
cp "${LLMOS_SRC}/.env.example" "${LLMOS_DEST}/.env"
sed -i 's|OLLAMA_URL=.*|OLLAMA_URL=http://localhost:11434|' "${LLMOS_DEST}/.env"

# --- Permissions ---
echo "  Setting permissions..."
chmod +x "${TARGET_DIR}/etc/init.d/"S* 2>/dev/null || true
chmod +x "${TARGET_DIR}/usr/local/bin/llmos-login" 2>/dev/null || true
chmod +x "${TARGET_DIR}/etc/profile.d/llmos.sh" 2>/dev/null || true

# --- Create /var directories ---
mkdir -p "${TARGET_DIR}/var/log"
mkdir -p "${TARGET_DIR}/var/run"

# --- Fix dropbear: remove symlink if present, create real directory ---
if [ -L "${TARGET_DIR}/etc/dropbear" ]; then
    rm -f "${TARGET_DIR}/etc/dropbear"
fi
mkdir -p "${TARGET_DIR}/etc/dropbear"

# --- Ensure /dev/pts exists for devpts mount ---
mkdir -p "${TARGET_DIR}/dev/pts"

echo "[llmos] Post-build complete."
