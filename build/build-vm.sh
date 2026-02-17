#!/bin/bash
set -euo pipefail

# LLM OS VM Image Builder
# Creates a bootable Alpine Linux disk image with Docker + Node.js + our kernel.
# Must run as root (or in a privileged container).

DISK_SIZE="4G"
IMAGE_RAW="/tmp/llmos.raw"
MOUNT_DIR="/tmp/rootfs"
VERSION="0.1.0"

echo "
╔══════════════════════════════════════╗
║       LLM OS Image Builder          ║
║       v${VERSION}                        ║
╚══════════════════════════════════════╝
"

# --- Step 1: Create raw disk image ---
echo "[1/7] Creating ${DISK_SIZE} disk image..."
truncate -s "${DISK_SIZE}" "${IMAGE_RAW}"

# Partition: 256MB EFI + rest ext4
parted -s "${IMAGE_RAW}" \
    mklabel gpt \
    mkpart ESP fat32 1MiB 257MiB \
    set 1 esp on \
    mkpart root ext4 257MiB 100%

# --- Step 2: Set up loop device ---
echo "[2/7] Setting up loop device..."
LOOP=$(losetup --find --show --partscan "${IMAGE_RAW}")
echo "  Loop device: ${LOOP}"

# Wait for partitions
sleep 1
partprobe "${LOOP}" 2>/dev/null || true
sleep 1

PART_EFI="${LOOP}p1"
PART_ROOT="${LOOP}p2"

# Format partitions
mkfs.fat -F32 "${PART_EFI}"
mkfs.ext4 -L LLMOS -q "${PART_ROOT}"

# --- Step 3: Mount and install Alpine ---
echo "[3/7] Installing Alpine Linux..."
mkdir -p "${MOUNT_DIR}"
mount "${PART_ROOT}" "${MOUNT_DIR}"
mkdir -p "${MOUNT_DIR}/boot/efi"
mount "${PART_EFI}" "${MOUNT_DIR}/boot/efi"

# Bootstrap Alpine rootfs
apk --arch x86_64 --root "${MOUNT_DIR}" --initdb \
    --repository "https://dl-cdn.alpinelinux.org/alpine/v3.21/main" \
    --repository "https://dl-cdn.alpinelinux.org/alpine/v3.21/community" \
    add alpine-base linux-lts linux-firmware-none

# --- Step 4: Configure rootfs ---
echo "[4/7] Configuring system..."

# Copy resolver for chroot
cp /etc/resolv.conf "${MOUNT_DIR}/etc/resolv.conf"

# Mount pseudo-filesystems
mount --bind /dev "${MOUNT_DIR}/dev"
mount --bind /proc "${MOUNT_DIR}/proc"
mount --bind /sys "${MOUNT_DIR}/sys"

# Set up APK repos in chroot
cat > "${MOUNT_DIR}/etc/apk/repositories" << 'EOF'
https://dl-cdn.alpinelinux.org/alpine/v3.21/main
https://dl-cdn.alpinelinux.org/alpine/v3.21/community
EOF

# Copy setup script and run in chroot
cp /build/setup-rootfs.sh "${MOUNT_DIR}/tmp/setup-rootfs.sh"
chroot "${MOUNT_DIR}" /bin/sh /tmp/setup-rootfs.sh
rm "${MOUNT_DIR}/tmp/setup-rootfs.sh"

# --- Step 5: Install LLM OS ---
echo "[5/7] Installing LLM OS kernel..."

mkdir -p "${MOUNT_DIR}/opt/llm-os"
rsync -a /build/llmos-src/ "${MOUNT_DIR}/opt/llm-os/"
cp /build/llmos-src/.env.example "${MOUNT_DIR}/opt/llm-os/.env"

# Default: Ollama on localhost (user can change)
sed -i 's|OLLAMA_URL=.*|OLLAMA_URL=http://localhost:11434|' "${MOUNT_DIR}/opt/llm-os/.env"

# Install overlay files (init scripts, motd, login)
rsync -a /build/overlay/ "${MOUNT_DIR}/"

# Make init scripts executable
chmod +x "${MOUNT_DIR}/etc/init.d/llmos" 2>/dev/null || true
chmod +x "${MOUNT_DIR}/etc/local.d/llmos-firstboot.start" 2>/dev/null || true
chmod +x "${MOUNT_DIR}/usr/local/bin/llmos-login" 2>/dev/null || true

# Enable LLM OS service
chroot "${MOUNT_DIR}" rc-update add llmos default

# --- Step 6: Install GRUB bootloader ---
echo "[6/7] Installing GRUB bootloader..."

# fstab
ROOT_UUID=$(blkid -s UUID -o value "${PART_ROOT}")
EFI_UUID=$(blkid -s UUID -o value "${PART_EFI}")
cat > "${MOUNT_DIR}/etc/fstab" << EOF
UUID=${ROOT_UUID}  /         ext4  defaults,noatime  0 1
UUID=${EFI_UUID}   /boot/efi vfat  defaults          0 2
EOF

# GRUB config
mkdir -p "${MOUNT_DIR}/boot/grub"
cat > "${MOUNT_DIR}/boot/grub/grub.cfg" << EOF
set default=0
set timeout=3

menuentry "LLM OS v${VERSION}" {
    linux /boot/vmlinuz-lts root=UUID=${ROOT_UUID} rootfstype=ext4 modules=ext4 console=tty1 console=ttyS0,115200n8 quiet
    initrd /boot/initramfs-lts
}

menuentry "LLM OS v${VERSION} (recovery)" {
    linux /boot/vmlinuz-lts root=UUID=${ROOT_UUID} rootfstype=ext4 modules=ext4 console=tty1 single
    initrd /boot/initramfs-lts
}
EOF

# Install GRUB for BIOS
grub-install --target=i386-pc --boot-directory="${MOUNT_DIR}/boot" --recheck "${LOOP}"

# Install GRUB for EFI
grub-install --target=x86_64-efi --boot-directory="${MOUNT_DIR}/boot" \
    --efi-directory="${MOUNT_DIR}/boot/efi" --removable --no-nvram 2>/dev/null || true

# --- Step 7: Output ---
echo "[7/7] Creating output images..."

# Cleanup mounts
umount "${MOUNT_DIR}/dev" 2>/dev/null || true
umount "${MOUNT_DIR}/proc" 2>/dev/null || true
umount "${MOUNT_DIR}/sys" 2>/dev/null || true
umount "${MOUNT_DIR}/boot/efi"
umount "${MOUNT_DIR}"
losetup -d "${LOOP}"

# Convert to QCOW2 (Proxmox)
mkdir -p /output
qemu-img convert -f raw -O qcow2 -c "${IMAGE_RAW}" "/output/llmos-${VERSION}.qcow2"
echo "  QCOW2: /output/llmos-${VERSION}.qcow2 ($(du -h /output/llmos-${VERSION}.qcow2 | cut -f1))"

# Convert to VHDX (Hyper-V)
qemu-img convert -f raw -O vhdx "${IMAGE_RAW}" "/output/llmos-${VERSION}.vhdx"
echo "  VHDX:  /output/llmos-${VERSION}.vhdx ($(du -h /output/llmos-${VERSION}.vhdx | cut -f1))"

# Keep raw too (universal)
cp "${IMAGE_RAW}" "/output/llmos-${VERSION}.raw"

echo "
╔══════════════════════════════════════╗
║        Build complete!               ║
║                                      ║
║  Boot the VM, then open:             ║
║  http://<vm-ip>:3000                 ║
║                                      ║
║  SSH: root / llmos                   ║
║  Change password on first login!     ║
╚══════════════════════════════════════╝
"
