#!/bin/sh
# Boot test for a built VM image: the release is only as good as this.
#
#   build/test/vm-boot-test.sh <os-image.qcow2> [boot-timeout-seconds]
#
# 1. Boots the image with an empty data disk (like a user attaching
#    llmos-data) and waits for the kernel API.
# 2. Changes a setting and writes app storage.
# 3. Presses the virtual power button and requires a clean power-off —
#    this is what "Shut down" in Proxmox / Hyper-V / VirtualBox does.
# 4. Boots a FRESH copy of the OS image with the same data disk (an
#    upgrade) and requires the data to be there.
#
# Needs qemu-system-x86_64, qemu-img, mkfs.ext4, curl, python3. Uses KVM
# when /dev/kvm is usable, plain emulation otherwise (slower).
set -u

IMAGE=${1:?usage: vm-boot-test.sh <image.qcow2> [timeout]}
TIMEOUT=${2:-300}
WORK=$(mktemp -d)
PORT=${LLMOS_TEST_PORT:-3950}
MON="$WORK/mon.sock"
QPID=""
trap '[ -n "$QPID" ] && kill "$QPID" 2>/dev/null; rm -rf "$WORK"' EXIT

ACCEL="-machine accel=tcg"
[ -w /dev/kvm ] && ACCEL="-enable-kvm"

fail() { echo "FAIL: $*"; [ -f "$WORK/serial.log" ] && { echo "--- serial (tail)"; tail -30 "$WORK/serial.log" | tr -d '\r'; }; exit 1; }
api() { curl -s -m 5 -H 'Content-Type: application/json' "$@"; }
monitor() {
  python3 - "$MON" "$1" <<'EOF'
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); time.sleep(0.3)
s.sendall((sys.argv[2] + '\n').encode()); time.sleep(0.5); s.close()
EOF
}

boot() { # $1 = os disk
  rm -f "$MON"
  qemu-system-x86_64 $ACCEL -m 2048 -smp 2 -display none \
    -drive file="$1",if=virtio,format=qcow2 \
    -drive file="$WORK/data.qcow2",if=virtio,format=qcow2 \
    -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$PORT-:3000 -device virtio-net-pci,netdev=n0 \
    -serial file:"$WORK/serial.log" -monitor unix:"$MON",server,nowait &
  QPID=$!
  t=0
  until api "http://127.0.0.1:$PORT/api/version" | grep -q version; do
    kill -0 "$QPID" 2>/dev/null || fail "VM exited during boot"
    [ $t -ge "$TIMEOUT" ] && fail "API not up after ${TIMEOUT}s"
    sleep 5; t=$((t + 5))
  done
  echo "  up after ~${t}s: $(api "http://127.0.0.1:$PORT/api/version")"
}

power_button() {
  monitor system_powerdown
  t=0
  while kill -0 "$QPID" 2>/dev/null; do
    [ $t -ge 90 ] && fail "still running 90s after the power button (ACPI shutdown ignored)"
    sleep 1; t=$((t + 1))
  done
  wait "$QPID" 2>/dev/null
  QPID=""
  echo "  powered off ${t}s after the power button"
}

# The same empty data disk the release ships
truncate -s 8G "$WORK/data.img"
mkfs.ext4 -q -L LLMOSDATA -m 0 "$WORK/data.img"
qemu-img convert -O qcow2 "$WORK/data.img" "$WORK/data.qcow2"
rm "$WORK/data.img"

echo "== boot 1: $IMAGE ($ACCEL)"
cp "$IMAGE" "$WORK/os1.qcow2"
boot "$WORK/os1.qcow2"
api "http://127.0.0.1:$PORT/api/boot?format=text" | sed 's/^/  /'
api "http://127.0.0.1:$PORT/api/boot?format=text" | grep -q "data disk" || fail "user data is not on the data disk"
api -X POST -d '{"preset":"dock"}' "http://127.0.0.1:$PORT/api/desktop" | grep -q '"preset":"dock"' || fail "could not change the desktop"
api -X PUT -d '{"value":"survives-upgrade"}' "http://127.0.0.1:$PORT/api/storage/boot-test/marker" | grep -q '"ok":true' || fail "could not write app storage"
sleep 2 # storage writes are debounced
power_button

echo "== boot 2: fresh OS disk, same data disk"
cp "$IMAGE" "$WORK/os2.qcow2"
boot "$WORK/os2.qcow2"
api "http://127.0.0.1:$PORT/api/desktop" | grep -q '"preset":"dock"' || fail "desktop setting lost across the upgrade"
api "http://127.0.0.1:$PORT/api/storage/boot-test/marker" | grep -q survives-upgrade || fail "app storage lost across the upgrade"
echo "  desktop and app storage survived"
power_button
echo "PASS"
