#!/bin/sh
# Shared helpers for the VM image tests (source this file).
#
# Needs: qemu-system-x86_64, qemu-img, mkfs.ext4, curl, python3.
# Uses KVM when /dev/kvm is usable, plain emulation otherwise (slower).
#
#   VM_WORK   scratch directory (created by vm_init)
#   VM_PORT   host port forwarded to the VM's :3000
#   VM_PID    qemu process of the running VM

VM_PORT=${VM_PORT:-3950}
VM_PID=""
VM_ACCEL="-machine accel=tcg"
[ -w /dev/kvm ] && VM_ACCEL="-enable-kvm"

vm_init() {
  VM_WORK=$(mktemp -d)
  trap 'vm_cleanup' EXIT
}

vm_cleanup() {
  [ -n "$VM_PID" ] && kill "$VM_PID" 2>/dev/null
  [ -n "${VM_KEEP:-}" ] || rm -rf "$VM_WORK"
}

vm_fail() {
  echo "FAIL: $*"
  [ -f "$VM_WORK/serial.log" ] && { echo "--- serial (tail)"; tail -30 "$VM_WORK/serial.log" | tr -d '\r'; }
  exit 1
}

vm_api() { curl -s -m 5 -H 'Content-Type: application/json' "$@"; }
vm_url() { echo "http://127.0.0.1:$VM_PORT$1"; }

vm_monitor() { # $1 = monitor command
  python3 - "$VM_WORK/mon.sock" "$1" <<'EOF'
import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); time.sleep(0.3)
try: s.recv(4096)
except Exception: pass
s.sendall((sys.argv[2] + '\n').encode()); time.sleep(0.8); s.close()
EOF
}

# An empty data disk like the release's llmos-data; $1 = optional directory
# whose files are put on it first (e.g. a .env for the test model).
vm_data_disk() {
  truncate -s 8G "$VM_WORK/data.img"
  if [ -n "${1:-}" ]; then
    mkfs.ext4 -q -L LLMOSDATA -m 0 -d "$1" "$VM_WORK/data.img"
  else
    mkfs.ext4 -q -L LLMOSDATA -m 0 "$VM_WORK/data.img"
  fi
  qemu-img convert -O qcow2 "$VM_WORK/data.img" "$VM_WORK/data.qcow2"
  rm "$VM_WORK/data.img"
}

vm_boot() { # $1 = os disk image, $2 = boot timeout in seconds
  rm -f "$VM_WORK/mon.sock"
  cp "$1" "$VM_WORK/os.qcow2"
  qemu-system-x86_64 $VM_ACCEL -m 2048 -smp 2 -vga std -display none \
    -drive file="$VM_WORK/os.qcow2",if=virtio,format=qcow2 \
    -drive file="$VM_WORK/data.qcow2",if=virtio,format=qcow2 \
    -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$VM_PORT-:3000 -device virtio-net-pci,netdev=n0 \
    -serial file:"$VM_WORK/serial.log" -monitor unix:"$VM_WORK/mon.sock",server,nowait &
  VM_PID=$!
  t=0
  until vm_api "$(vm_url /api/version)" | grep -q version; do
    kill -0 "$VM_PID" 2>/dev/null || vm_fail "VM exited during boot"
    [ $t -ge "${2:-300}" ] && vm_fail "API not up after ${2:-300}s"
    sleep 5; t=$((t + 5))
  done
  echo "  up after ~${t}s: $(vm_api "$(vm_url /api/version)")"
}

vm_power_button() {
  vm_monitor system_powerdown
  t=0
  while kill -0 "$VM_PID" 2>/dev/null; do
    [ $t -ge 90 ] && vm_fail "still running 90s after the power button (ACPI shutdown ignored)"
    sleep 1; t=$((t + 1))
  done
  wait "$VM_PID" 2>/dev/null
  VM_PID=""
  echo "  powered off ${t}s after the power button"
}

# Save the VM's screen as PNG ($1 = path); prints a summary of what is on it
vm_screen() {
  vm_monitor "screendump $VM_WORK/screen.ppm"
  python3 "$(dirname "$0")/screen-check.py" "$VM_WORK/screen.ppm" "$1"
}
