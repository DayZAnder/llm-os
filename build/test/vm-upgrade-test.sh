#!/bin/sh
# Upgrade and rollback between two releases of the same image variant.
#
#   build/test/vm-upgrade-test.sh <previous.qcow2> <new.qcow2> [timeout]
#
# 1. The previous release runs with a data disk and the user changes things.
# 2. Upgrade: the new release boots with that data disk — everything must be
#    there, and the data format check must be happy.
# 3. Rollback: the previous release boots again with the same disk — it must
#    still start and still see the user's data.
set -u
. "$(dirname "$0")/vm-lib.sh"

PREV=${1:?usage: vm-upgrade-test.sh <previous.qcow2> <new.qcow2> [timeout]}
NEW=${2:?usage: vm-upgrade-test.sh <previous.qcow2> <new.qcow2> [timeout]}
TIMEOUT=${3:-300}
vm_init
vm_data_disk

echo "== previous release: $PREV"
vm_boot "$PREV" "$TIMEOUT"
vm_api -X POST -d '{"preset":"dock"}' "$(vm_url /api/desktop)" | grep -q '"preset":"dock"' || vm_fail "could not change the desktop"
vm_api -X PUT -d '{"value":"made-on-the-old-version"}' "$(vm_url /api/storage/upgrade-test/marker)" | grep -q '"ok":true' || vm_fail "could not write app storage"
APPS_BEFORE=$(vm_api "$(vm_url /api/registry/stats)" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("totalApps", 0))' 2>/dev/null || echo 0)
sleep 2
vm_power_button

echo "== upgrade: $NEW, same data disk"
vm_boot "$NEW" "$TIMEOUT"
vm_api "$(vm_url /api/desktop)" | grep -q '"preset":"dock"' || vm_fail "desktop setting lost in the upgrade"
vm_api "$(vm_url /api/storage/upgrade-test/marker)" | grep -q made-on-the-old-version || vm_fail "app storage lost in the upgrade"
APPS_AFTER=$(vm_api "$(vm_url /api/registry/stats)" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("totalApps", 0))' 2>/dev/null || echo 0)
[ "$APPS_AFTER" -ge "$APPS_BEFORE" ] || vm_fail "apps lost in the upgrade ($APPS_BEFORE → $APPS_AFTER)"
DATA=$(vm_api "$(vm_url '/api/boot?format=text')" | grep "Your data")
echo "  $DATA"
echo "$DATA" | grep -q '^\[  OK  \]' || vm_fail "data check not OK after the upgrade"
echo "  settings, app storage and $APPS_AFTER apps carried over"
vm_power_button

echo "== rollback: $PREV again, same data disk"
vm_boot "$PREV" "$TIMEOUT"
vm_api "$(vm_url /api/storage/upgrade-test/marker)" | grep -q made-on-the-old-version || vm_fail "the previous release can't read the data after the upgrade"
vm_api "$(vm_url /api/desktop)" | grep -q '"preset":"dock"' || vm_fail "desktop setting unreadable after rollback"
echo "  the previous release still reads the data"
vm_power_button
echo "PASS"
