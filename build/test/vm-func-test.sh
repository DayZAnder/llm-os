#!/bin/sh
# Functional test of a VM image: does it do what it is for?
#
#   build/test/vm-func-test.sh <image.qcow2> <micro|server|desktop> [artifact-dir]
#
# Boots the image with a data disk whose .env points the OS at the model
# stub (tests/e2e/stub-model.mjs, on this host — QEMU's 10.0.2.2), then runs
# a user's first session in headless Chrome (tests/e2e/shell-journey.mjs):
# write an app, use files, open a file in its app, a refused permission,
# desktop layout, display scale. The desktop image is also checked on its
# own screen: the kiosk shows the shell (not a console), and keys reach it.
#
# Needs, besides vm-lib.sh's tools: node, and Chrome or Chromium (CHROME=…).
set -u
. "$(dirname "$0")/vm-lib.sh"

IMAGE=${1:?usage: vm-func-test.sh <image.qcow2> <variant> [artifact-dir]}
VARIANT=${2:?variant: micro, server or desktop}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ART=${3:-$ROOT/e2e-artifacts/$VARIANT}
mkdir -p "$ART"
STUB_PORT=${STUB_PORT:-3999}

vm_init
node "$ROOT/tests/e2e/stub-model.mjs" "$STUB_PORT" 0.0.0.0 > "$VM_WORK/stub.log" 2>&1 &
STUB=$!
trap 'kill $STUB 2>/dev/null; cp "$VM_WORK/serial.log" "$ART/serial.log" 2>/dev/null; vm_cleanup' EXIT

mkdir -p "$VM_WORK/seed"
printf 'PRIMARY_PROVIDER=openai\nOPENAI_API_KEY=e2e\nOPENAI_BASE_URL=http://10.0.2.2:%s/v1\nOPENAI_MODEL=e2e-stub\n' "$STUB_PORT" > "$VM_WORK/seed/.env"
vm_data_disk "$VM_WORK/seed"

echo "== $VARIANT: $IMAGE ($VM_ACCEL)"
case "$VARIANT" in micro) TIMEOUT=300 ;; *) TIMEOUT=900 ;; esac
vm_boot "$IMAGE" "$TIMEOUT"

FAILS=0
check() { if [ "$1" = 1 ]; then echo "  ✓ $2"; else echo "  ✗ $2${3:+ — $3}"; FAILS=$((FAILS + 1)); fi; }

if [ "$VARIANT" = desktop ]; then
  echo "kiosk on the VM's own screen:"
  t=0; GUI=0
  while [ $t -lt 240 ]; do
    S=$(vm_screen "$ART/10-kiosk.png")
    echo "$S" | grep -q '"gui": true' && { GUI=1; break; }
    sleep 5; t=$((t + 5))
  done
  check $GUI "the kiosk shows the shell, not a console" "$S"
  sleep 5 # let the boot screen settle
  cp "$VM_WORK/screen.ppm" "$VM_WORK/a.ppm" 2>/dev/null
  vm_monitor "sendkey ret"       # Continue on the boot screen
  sleep 3
  vm_screen "$ART/11-after-enter.png" >/dev/null; cp "$VM_WORK/screen.ppm" "$VM_WORK/b.ppm"
  vm_monitor "sendkey ctrl-spc"  # the launcher
  sleep 3
  vm_screen "$ART/12-launcher.png" >/dev/null; cp "$VM_WORK/screen.ppm" "$VM_WORK/c.ppm"
  D1=$(python3 "$(dirname "$0")/screen-check.py" diff "$VM_WORK/a.ppm" "$VM_WORK/b.ppm")
  D2=$(python3 "$(dirname "$0")/screen-check.py" diff "$VM_WORK/b.ppm" "$VM_WORK/c.ppm")
  check "$(python3 -c "print(1 if $D1 + $D2 > 0.02 else 0)")" "keyboard input reaches the shell (screen changed: $D1, $D2)"
fi

echo "a user's first session (headless browser):"
# The CDP driver needs a global WebSocket (Node 22+, or a flag on 20/21)
NODE_FLAGS=""
node -e 'process.exit(typeof WebSocket === "undefined" ? 1 : 0)' || NODE_FLAGS="--experimental-websocket"
node $NODE_FLAGS "$ROOT/tests/e2e/shell-journey.mjs" "$(vm_url '')" "$ART" || FAILS=$((FAILS + 1))

vm_power_button
[ $FAILS -eq 0 ] && echo "PASS" || { echo "FAIL ($FAILS)"; exit 1; }
