#!/bin/sh
# Real-mount tests for llmos-data-setup and llmos-data-move.
# Needs root and loop devices (CI runs it with sudo): sudo sh tests/vm/data-disk.test.sh
export PATH="$PATH:/usr/sbin:/sbin"
BIN="$(cd "$(dirname "$0")/../../build/rootfs/usr/local/bin" && pwd)"
T=$(mktemp -d)
ok() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1"; FAILED=1; }
newdisk() { truncate -s 64M "$1"; mkfs.ext4 -q -L LLMOSDATA "$1"; losetup -f --show "$1"; }
check() { if eval "$1"; then ok "$2"; else fail "$2"; fi; }

echo "A. 0.4.1 install with data on the system disk, data disk attached later"
DATA=$T/a/data; APP=$T/a/app; mkdir -p "$DATA/fs/docs" "$APP"
echo "LLM OS data v1" > "$DATA/.llmos-data"; echo "mine" > "$DATA/fs/docs/note.txt"; echo "KEY=1" > "$DATA/.env"
L1=$(newdisk "$T/a.img")
LLMOS_DATA_DEV=$L1 LLMOS_DATA_ROOT=$DATA LLMOS_APP_DIR=$APP sh $BIN/llmos-data-setup >/dev/null 2>"$T/a.log"
check "grep -q \" $DATA \" /proc/mounts" "data disk mounted at the data path"
check "[ \"\$(cat $DATA/fs/docs/note.txt 2>/dev/null)\" = mine ]" "existing data visible on the data disk (not hidden)"
check "grep -q KEY=1 $DATA/.env" ".env carried over"
umount "$DATA"
check "[ -f $DATA/fs/docs/note.txt ]" "system-disk copy left in place as backup"

echo "B. pre-0.4.1 install: llmos-data-move, then swap the OS disk"
APP=$T/b/app; DATA=$T/b/data; mkdir -p "$APP/data/fs/docs" "$DATA"
echo "old" > "$APP/data/fs/docs/old.txt"; echo '{"apps":1}' > "$APP/data/registry.json"; echo "ANTHROPIC_API_KEY=sk-x" > "$APP/.env"
L2=$(newdisk "$T/b.img")
LLMOS_NO_SERVICE=1 LLMOS_DATA_ROOT=$DATA LLMOS_APP_DIR=$APP sh $BIN/llmos-data-move "$L2" > "$T/b.log" 2>&1
check "grep -q 'done: 2 files' $T/b.log" "move reports success ($(tail -n 2 $T/b.log | head -n 1 | cut -c1-60))"
M=$T/b/m; mkdir -p "$M"; mount "$L2" "$M"
check "[ -f $M/fs/docs/old.txt ] && [ -f $M/registry.json ]" "files on the data disk"
check "grep -q sk-x $M/.env && [ \$(stat -c %a $M/.env) = 600 ]" ".env on the disk, mode 600"
check "[ -f $M/.llmos-data ]" "disk marked as LLM OS data"
umount "$M"
# New OS disk: fresh app dir, no old data
APP2=$T/b/app2; DATA2=$T/b/data2; mkdir -p "$APP2/data" "$DATA2"; echo '{"fresh":true}' > "$APP2/data/registry.json"
LLMOS_DATA_DEV=$L2 LLMOS_DATA_ROOT=$DATA2 LLMOS_APP_DIR=$APP2 sh $BIN/llmos-data-setup >/dev/null 2>&1
check "[ \"\$(cat $DATA2/registry.json)\" = '{\"apps\":1}' ]" "new OS sees the old registry, not its own empty one"
check "grep -q sk-x $DATA2/.env" "new OS uses the old settings"
umount "$DATA2"

echo "C. llmos-data-move refuses a disk that already has data"
LLMOS_NO_SERVICE=1 LLMOS_DATA_ROOT=$DATA LLMOS_APP_DIR=$APP sh $BIN/llmos-data-move "$L2" > "$T/c.log" 2>&1
code=$?
check "[ $code -ne 0 ] && grep -q 'already holds LLM OS data' $T/c.log" "refused without --force (exit $code)"

echo "D. no data disk: clear message"
LLMOS_NO_SERVICE=1 LLMOS_DATA_ROOT=$DATA LLMOS_APP_DIR=$APP sh $BIN/llmos-data-move /dev/does-not-exist > "$T/d.log" 2>&1
check "grep -q 'not a block device' $T/d.log" "reports a bad device"

losetup -d "$L1" "$L2"
rm -rf "$T"
if [ -z "$FAILED" ]; then echo "ALL PASSED"; else echo "SOME FAILED"; exit 1; fi
