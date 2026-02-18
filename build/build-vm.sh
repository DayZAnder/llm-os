#!/bin/bash
set -euo pipefail

# LLM OS VM Image Builder
# Creates a bootable Alpine Linux disk image with Docker + Node.js + our kernel.
# Must run as root (or in a privileged container).

DISK_SIZE_MB=4096
IMAGE_RAW="/tmp/llmos.raw"
MOUNT_DIR="/tmp/rootfs"
VERSION="0.2.2"
VARIANT="${VARIANT:-server}"  # server (headless) or desktop (kiosk Chromium)

echo "
╔══════════════════════════════════════╗
║       LLM OS Image Builder          ║
║       v${VERSION} (${VARIANT})              ║
╚══════════════════════════════════════╝
"

# --- Step 1: Create raw disk image with MBR (simpler, wider compat) ---
echo "[1/7] Creating ${DISK_SIZE_MB}MB disk image..."
dd if=/dev/zero of="${IMAGE_RAW}" bs=1M count=${DISK_SIZE_MB} status=none

# MBR partition: 1 big ext4 partition (BIOS boot)
# Simpler than GPT+EFI — works on all hypervisors
echo -e "o\nn\np\n1\n2048\n\na\nw" | fdisk "${IMAGE_RAW}" >/dev/null 2>&1

# --- Step 2: Set up loop device with offset ---
echo "[2/7] Setting up loop device..."

# Partition 1 starts at sector 2048, sector size 512 = offset 1048576
OFFSET=$((2048 * 512))
SIZE_BYTES=$(stat -c %s "${IMAGE_RAW}")
PART_SIZE=$(( SIZE_BYTES - OFFSET ))

# Loop for entire disk (for grub-install)
LOOP_DISK=$(losetup --find --show "${IMAGE_RAW}")
echo "  Disk: ${LOOP_DISK}"

# Loop for partition (with offset)
LOOP_PART=$(losetup --find --show --offset ${OFFSET} --sizelimit ${PART_SIZE} "${IMAGE_RAW}")
echo "  Part: ${LOOP_PART}"

# Format root partition
mkfs.ext4 -L LLMOS -q "${LOOP_PART}"

# --- Step 3: Mount and install Alpine ---
echo "[3/7] Installing Alpine Linux..."
mkdir -p "${MOUNT_DIR}"
mount "${LOOP_PART}" "${MOUNT_DIR}"

# Bootstrap Alpine rootfs
# Copy APK keys so signatures are trusted
mkdir -p "${MOUNT_DIR}/etc/apk/keys"
cp /etc/apk/keys/* "${MOUNT_DIR}/etc/apk/keys/"

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
chroot "${MOUNT_DIR}" /bin/sh -c "VARIANT=${VARIANT} /tmp/setup-rootfs.sh"
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
chmod +x "${MOUNT_DIR}/usr/local/bin/llmos-config" 2>/dev/null || true
chmod +x "${MOUNT_DIR}/usr/local/bin/llmos-kiosk" 2>/dev/null || true
chmod +x "${MOUNT_DIR}/etc/init.d/llmos-kiosk" 2>/dev/null || true

# Enable LLM OS service
chroot "${MOUNT_DIR}" rc-update add llmos default

# Enable kiosk mode for desktop variant
if [ "${VARIANT}" = "desktop" ]; then
    echo "  Enabling kiosk browser mode..."
    chroot "${MOUNT_DIR}" rc-update add llmos-kiosk default
    # Replace tty1 login with kiosk on desktop variant
    sed -i 's|tty1::respawn:/sbin/getty -n -l /usr/local/bin/llmos-login 38400 tty1|tty1::respawn:/usr/local/bin/llmos-kiosk|' "${MOUNT_DIR}/etc/inittab"
fi

# --- Step 6: Install GRUB bootloader ---
echo "[6/7] Installing GRUB bootloader..."

# fstab — use label since UUID may not be reliable with loop offset
cat > "${MOUNT_DIR}/etc/fstab" << 'EOF'
LABEL=LLMOS  /  ext4  defaults,noatime  0 1
EOF

# Install extlinux (simpler than GRUB, works in Docker)
chroot "${MOUNT_DIR}" apk add --no-cache syslinux 2>/dev/null || true

mkdir -p "${MOUNT_DIR}/boot/extlinux"
cat > "${MOUNT_DIR}/boot/extlinux/extlinux.conf" << EOF
DEFAULT llmos
PROMPT 1
TIMEOUT 30

LABEL llmos
    MENU LABEL LLM OS v${VERSION}
    LINUX /boot/vmlinuz-lts
    INITRD /boot/initramfs-lts
    APPEND root=LABEL=LLMOS rootfstype=ext4 modules=ext4,virtio_blk,virtio_net,virtio_pci,hv_vmbus,hv_storvsc,hv_netvsc console=tty1 console=ttyS0,115200n8 quiet

LABEL recovery
    MENU LABEL LLM OS v${VERSION} (recovery)
    LINUX /boot/vmlinuz-lts
    INITRD /boot/initramfs-lts
    APPEND root=LABEL=LLMOS rootfstype=ext4 modules=ext4 console=tty1 single
EOF

# Install syslinux MBR
if [ -f /usr/share/syslinux/mbr.bin ]; then
    dd if=/usr/share/syslinux/mbr.bin of="${IMAGE_RAW}" bs=440 count=1 conv=notrunc
elif [ -f "${MOUNT_DIR}/usr/share/syslinux/mbr.bin" ]; then
    dd if="${MOUNT_DIR}/usr/share/syslinux/mbr.bin" of="${IMAGE_RAW}" bs=440 count=1 conv=notrunc
fi

# Install extlinux to boot partition
chroot "${MOUNT_DIR}" extlinux --install /boot/extlinux 2>/dev/null || \
    extlinux --install "${MOUNT_DIR}/boot/extlinux" 2>/dev/null || true

# Fallback: try GRUB if extlinux failed
if [ ! -f "${MOUNT_DIR}/boot/extlinux/ldlinux.sys" ]; then
    echo "  extlinux failed, trying GRUB..."
    mkdir -p "${MOUNT_DIR}/boot/grub"
    cat > "${MOUNT_DIR}/boot/grub/grub.cfg" << EOF
set default=0
set timeout=3

menuentry "LLM OS v${VERSION}" {
    linux /boot/vmlinuz-lts root=LABEL=LLMOS rootfstype=ext4 modules=ext4 console=tty1 console=ttyS0,115200n8 quiet
    initrd /boot/initramfs-lts
}
EOF
    grub-install --target=i386-pc --boot-directory="${MOUNT_DIR}/boot" --recheck "${LOOP_DISK}" 2>/dev/null || true
fi

# --- Step 7: Output ---
echo "[7/7] Creating output images..."

# Cleanup mounts
sync
umount "${MOUNT_DIR}/dev" 2>/dev/null || true
umount "${MOUNT_DIR}/proc" 2>/dev/null || true
umount "${MOUNT_DIR}/sys" 2>/dev/null || true
umount "${MOUNT_DIR}"
losetup -d "${LOOP_PART}"
losetup -d "${LOOP_DISK}"

NAME="llmos-${VERSION}-${VARIANT}"
mkdir -p /output

# Convert to QCOW2 (Proxmox)
qemu-img convert -f raw -O qcow2 -c "${IMAGE_RAW}" "/output/${NAME}.qcow2"
QCOW2_SIZE=$(du -h "/output/${NAME}.qcow2" | cut -f1)
echo "  QCOW2: ${NAME}.qcow2 (${QCOW2_SIZE})"

# Convert to VHDX (Hyper-V)
qemu-img convert -f raw -O vhdx "${IMAGE_RAW}" "/output/${NAME}.vhdx"
VHDX_SIZE=$(du -h "/output/${NAME}.vhdx" | cut -f1)
echo "  VHDX:  ${NAME}.vhdx (${VHDX_SIZE})"

# Convert to OVA (VirtualBox)
echo "  Building OVA..."
OVA_DIR="/tmp/ova-${VARIANT}"
mkdir -p "${OVA_DIR}"

# Raw → VMDK (VirtualBox disk format)
qemu-img convert -f raw -O vmdk "${IMAGE_RAW}" "${OVA_DIR}/${NAME}-disk1.vmdk"
VMDK_SIZE=$(stat -c %s "${OVA_DIR}/${NAME}-disk1.vmdk")

# Generate OVF descriptor
cat > "${OVA_DIR}/${NAME}.ovf" << OVFEOF
<?xml version="1.0"?>
<Envelope ovf:version="1.0" xml:lang="en-US"
  xmlns="http://schemas.dmtf.org/ovf/envelope/1"
  xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
  xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
  xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData"
  xmlns:vbox="http://www.virtualbox.org/ovf/machine">

  <References>
    <File ovf:href="${NAME}-disk1.vmdk" ovf:id="file1" ovf:size="${VMDK_SIZE}"/>
  </References>

  <DiskSection>
    <Info>Virtual disk information</Info>
    <Disk ovf:capacity="${DISK_SIZE_MB}" ovf:capacityAllocationUnits="byte * 2^20"
          ovf:diskId="vmdisk1" ovf:fileRef="file1" ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
  </DiskSection>

  <NetworkSection>
    <Info>Logical networks</Info>
    <Network ovf:name="NAT">
      <Description>NAT network</Description>
    </Network>
  </NetworkSection>

  <VirtualSystem ovf:id="${NAME}">
    <Info>LLM OS - AI-native operating system</Info>
    <Name>${NAME}</Name>
    <OperatingSystemSection ovf:id="101">
      <Info>Linux 64-bit</Info>
      <Description>Linux26_64</Description>
    </OperatingSystemSection>

    <VirtualHardwareSection>
      <Info>Virtual hardware requirements</Info>
      <System>
        <vssd:ElementName>Virtual Hardware Family</vssd:ElementName>
        <vssd:InstanceID>0</vssd:InstanceID>
        <vssd:VirtualSystemIdentifier>${NAME}</vssd:VirtualSystemIdentifier>
        <vssd:VirtualSystemType>virtualbox-2.2</vssd:VirtualSystemType>
      </System>

      <Item>
        <rasd:Caption>2 virtual CPUs</rasd:Caption>
        <rasd:Description>Number of virtual CPUs</rasd:Description>
        <rasd:ElementName>2 virtual CPUs</rasd:ElementName>
        <rasd:InstanceID>1</rasd:InstanceID>
        <rasd:ResourceType>3</rasd:ResourceType>
        <rasd:VirtualQuantity>2</rasd:VirtualQuantity>
      </Item>

      <Item>
        <rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits>
        <rasd:Caption>2048 MB of memory</rasd:Caption>
        <rasd:Description>Memory Size</rasd:Description>
        <rasd:ElementName>2048 MB of memory</rasd:ElementName>
        <rasd:InstanceID>2</rasd:InstanceID>
        <rasd:ResourceType>4</rasd:ResourceType>
        <rasd:VirtualQuantity>2048</rasd:VirtualQuantity>
      </Item>

      <Item>
        <rasd:Address>0</rasd:Address>
        <rasd:Caption>ideController0</rasd:Caption>
        <rasd:Description>IDE Controller</rasd:Description>
        <rasd:ElementName>ideController0</rasd:ElementName>
        <rasd:InstanceID>3</rasd:InstanceID>
        <rasd:ResourceSubType>PIIX4</rasd:ResourceSubType>
        <rasd:ResourceType>5</rasd:ResourceType>
      </Item>

      <Item>
        <rasd:AddressOnParent>0</rasd:AddressOnParent>
        <rasd:Caption>disk1</rasd:Caption>
        <rasd:Description>Disk Image</rasd:Description>
        <rasd:ElementName>disk1</rasd:ElementName>
        <rasd:HostResource>/disk/vmdisk1</rasd:HostResource>
        <rasd:InstanceID>4</rasd:InstanceID>
        <rasd:Parent>3</rasd:Parent>
        <rasd:ResourceType>17</rasd:ResourceType>
      </Item>

      <Item>
        <rasd:AutomaticAllocation>true</rasd:AutomaticAllocation>
        <rasd:Caption>Ethernet adapter on NAT</rasd:Caption>
        <rasd:Connection>NAT</rasd:Connection>
        <rasd:ElementName>Ethernet adapter on NAT</rasd:ElementName>
        <rasd:InstanceID>5</rasd:InstanceID>
        <rasd:ResourceSubType>E1000</rasd:ResourceSubType>
        <rasd:ResourceType>10</rasd:ResourceType>
      </Item>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
OVFEOF

# Generate manifest with SHA256 checksums
cd "${OVA_DIR}"
sha256sum "${NAME}.ovf" "${NAME}-disk1.vmdk" | sed 's/ / = SHA256(/' | sed 's/$/)/' > "${NAME}.mf"

# Pack into OVA (tar, OVF first per spec)
tar cf "/output/${NAME}.ova" "${NAME}.ovf" "${NAME}-disk1.vmdk" "${NAME}.mf"
cd /
rm -rf "${OVA_DIR}"

OVA_SIZE=$(du -h "/output/${NAME}.ova" | cut -f1)
echo "  OVA:   ${NAME}.ova (${OVA_SIZE})"

echo "
╔══════════════════════════════════════╗
║        Build complete! (${VARIANT})       ║
║                                      ║
║  Boot the VM, then open:             ║
║  http://<vm-ip>:3000                 ║
║                                      ║
║  SSH: root / llmos                   ║
║  Change password on first login!     ║
╚══════════════════════════════════════╝
"
