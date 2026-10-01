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
set -u
. "$(dirname "$0")/vm-lib.sh"

IMAGE=${1:?usage: vm-boot-test.sh <image.qcow2> [timeout]}
TIMEOUT=${2:-300}
vm_init
vm_data_disk

echo "== boot 1: $IMAGE ($VM_ACCEL)"
vm_boot "$IMAGE" "$TIMEOUT"
vm_api "$(vm_url '/api/boot?format=text')" | sed 's/^/  /'
vm_api "$(vm_url '/api/boot?format=text')" | grep -q "data disk" || vm_fail "user data is not on the data disk"
vm_api -X POST -d '{"preset":"dock"}' "$(vm_url /api/desktop)" | grep -q '"preset":"dock"' || vm_fail "could not change the desktop"
vm_api -X PUT -d '{"value":"survives-upgrade"}' "$(vm_url /api/storage/boot-test/marker)" | grep -q '"ok":true' || vm_fail "could not write app storage"
sleep 2 # storage writes are debounced
vm_power_button

echo "== boot 2: fresh OS disk, same data disk"
vm_boot "$IMAGE" "$TIMEOUT"
vm_api "$(vm_url /api/desktop)" | grep -q '"preset":"dock"' || vm_fail "desktop setting lost across the upgrade"
vm_api "$(vm_url /api/storage/boot-test/marker)" | grep -q survives-upgrade || vm_fail "app storage lost across the upgrade"
echo "  desktop and app storage survived"
vm_power_button
echo "PASS"
