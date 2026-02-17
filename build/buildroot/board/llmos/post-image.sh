#!/bin/bash
set -euo pipefail

# Buildroot post-image hook
# Runs after rootfs.ext4 is created. Creates final disk images.
# Called with BINARIES_DIR as $1 (contains rootfs.ext4, bzImage, etc.)

BINARIES_DIR="${BINARIES_DIR:-$1}"
BOARD_DIR="$(dirname "$0")"
GENIMAGE_CFG="${BOARD_DIR}/genimage.cfg"
GENIMAGE_TMP="${BUILD_DIR}/genimage.tmp"
VERSION="0.1.0"
NAME="llmos-${VERSION}-micro"

echo "[llmos] Post-image: creating disk images..."

# --- Step 1: Install extlinux into rootfs ---
echo "  Installing extlinux bootloader..."

# Mount rootfs to install bootloader config
MOUNT_DIR="/tmp/llmos-rootfs"
mkdir -p "${MOUNT_DIR}"

# Create boot directory and extlinux config inside the ext4 image
# We use debugfs since we can't easily mount in all build environments
# Instead, create the extlinux files via the overlay (already done) and
# rely on syslinux MBR + extlinux on the final disk.

# Create extlinux config in a temp overlay that we'll inject
EXTLINUX_DIR="/tmp/extlinux-overlay/boot/extlinux"
mkdir -p "${EXTLINUX_DIR}"
cat > "${EXTLINUX_DIR}/extlinux.conf" << EOF
DEFAULT llmos
PROMPT 0
TIMEOUT 30

LABEL llmos
    MENU LABEL LLM OS Micro v${VERSION}
    LINUX /boot/bzImage
    APPEND root=LABEL=LLMOS rootfstype=ext4 console=tty1 console=ttyS0,115200n8 quiet
EOF

# Copy kernel to a place genimage can find it, named for extlinux
cp "${BINARIES_DIR}/bzImage" "/tmp/extlinux-overlay/boot/bzImage"

# Inject extlinux config and kernel into rootfs.ext4
# Use e2cp (from e2tools) or ext2 manipulation
if command -v e2cp >/dev/null 2>&1; then
    e2mkdir "${BINARIES_DIR}/rootfs.ext4:/boot/extlinux" 2>/dev/null || true
    e2cp "/tmp/extlinux-overlay/boot/extlinux/extlinux.conf" "${BINARIES_DIR}/rootfs.ext4:/boot/extlinux/"
    e2cp "/tmp/extlinux-overlay/boot/bzImage" "${BINARIES_DIR}/rootfs.ext4:/boot/"
else
    # Fallback: mount the ext4 image (needs root/privileged)
    mount -o loop "${BINARIES_DIR}/rootfs.ext4" "${MOUNT_DIR}" 2>/dev/null || {
        echo "  WARNING: Cannot mount rootfs.ext4 — trying debugfs"
        # Last resort: use debugfs to write files
        debugfs -w "${BINARIES_DIR}/rootfs.ext4" -R "mkdir /boot" 2>/dev/null || true
        debugfs -w "${BINARIES_DIR}/rootfs.ext4" -R "mkdir /boot/extlinux" 2>/dev/null || true
        debugfs -w "${BINARIES_DIR}/rootfs.ext4" -R "write /tmp/extlinux-overlay/boot/bzImage /boot/bzImage" 2>/dev/null || true
        debugfs -w "${BINARIES_DIR}/rootfs.ext4" -R "write /tmp/extlinux-overlay/boot/extlinux/extlinux.conf /boot/extlinux/extlinux.conf" 2>/dev/null || true
    }

    if mountpoint -q "${MOUNT_DIR}" 2>/dev/null; then
        mkdir -p "${MOUNT_DIR}/boot/extlinux"
        cp "/tmp/extlinux-overlay/boot/bzImage" "${MOUNT_DIR}/boot/"
        cp "/tmp/extlinux-overlay/boot/extlinux/extlinux.conf" "${MOUNT_DIR}/boot/extlinux/"

        # Install extlinux bootloader
        if command -v extlinux >/dev/null 2>&1; then
            extlinux --install "${MOUNT_DIR}/boot/extlinux" 2>/dev/null || true
        fi

        sync
        umount "${MOUNT_DIR}"
    fi
fi

rm -rf /tmp/extlinux-overlay

# --- Step 2: Generate disk image with genimage ---
echo "  Creating disk image..."
rm -rf "${GENIMAGE_TMP}"

genimage \
    --rootpath "${TARGET_DIR}" \
    --tmppath "${GENIMAGE_TMP}" \
    --inputpath "${BINARIES_DIR}" \
    --outputpath "${BINARIES_DIR}" \
    --config "${GENIMAGE_CFG}"

# --- Step 3: Install MBR bootloader ---
echo "  Installing MBR..."
SYSLINUX_MBR=""
for mbr_path in \
    "${HOST_DIR}/share/syslinux/mbr.bin" \
    "/usr/share/syslinux/mbr.bin" \
    "/usr/lib/syslinux/mbr/mbr.bin" \
    "/usr/lib/syslinux/bios/mbr.bin"; do
    if [ -f "${mbr_path}" ]; then
        SYSLINUX_MBR="${mbr_path}"
        break
    fi
done

if [ -n "${SYSLINUX_MBR}" ]; then
    dd if="${SYSLINUX_MBR}" of="${BINARIES_DIR}/disk.img" bs=440 count=1 conv=notrunc 2>/dev/null
    echo "  MBR installed from ${SYSLINUX_MBR}"
else
    echo "  WARNING: syslinux MBR not found — VM may not boot"
fi

# --- Step 4: Convert to output formats ---
echo "  Converting to output formats..."
mkdir -p /output

# QCOW2 (Proxmox / KVM)
qemu-img convert -f raw -O qcow2 -c "${BINARIES_DIR}/disk.img" "/output/${NAME}.qcow2"
QCOW2_SIZE=$(du -h "/output/${NAME}.qcow2" | cut -f1)
echo "  QCOW2: ${NAME}.qcow2 (${QCOW2_SIZE})"

# VHDX (Hyper-V)
qemu-img convert -f raw -O vhdx "${BINARIES_DIR}/disk.img" "/output/${NAME}.vhdx"
VHDX_SIZE=$(du -h "/output/${NAME}.vhdx" | cut -f1)
echo "  VHDX:  ${NAME}.vhdx (${VHDX_SIZE})"

# OVA (VirtualBox)
OVA_DIR="/tmp/ova-micro"
mkdir -p "${OVA_DIR}"

qemu-img convert -f raw -O vmdk "${BINARIES_DIR}/disk.img" "${OVA_DIR}/${NAME}-disk1.vmdk"
VMDK_SIZE=$(stat -c %s "${OVA_DIR}/${NAME}-disk1.vmdk")
DISK_SIZE_MB=256

cat > "${OVA_DIR}/${NAME}.ovf" << OVFEOF
<?xml version="1.0"?>
<Envelope ovf:version="1.0" xml:lang="en-US"
  xmlns="http://schemas.dmtf.org/ovf/envelope/1"
  xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
  xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData"
  xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData">

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
    <Info>LLM OS Micro - Minimal AI-native operating system</Info>
    <Name>${NAME}</Name>
    <OperatingSystemSection ovf:id="101">
      <Info>Linux 64-bit</Info>
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
        <rasd:Caption>1 virtual CPU</rasd:Caption>
        <rasd:ElementName>1 virtual CPU</rasd:ElementName>
        <rasd:InstanceID>1</rasd:InstanceID>
        <rasd:ResourceType>3</rasd:ResourceType>
        <rasd:VirtualQuantity>1</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits>
        <rasd:Caption>512 MB of memory</rasd:Caption>
        <rasd:ElementName>512 MB of memory</rasd:ElementName>
        <rasd:InstanceID>2</rasd:InstanceID>
        <rasd:ResourceType>4</rasd:ResourceType>
        <rasd:VirtualQuantity>512</rasd:VirtualQuantity>
      </Item>
      <Item>
        <rasd:Address>0</rasd:Address>
        <rasd:Caption>ideController0</rasd:Caption>
        <rasd:ElementName>ideController0</rasd:ElementName>
        <rasd:InstanceID>3</rasd:InstanceID>
        <rasd:ResourceSubType>PIIX4</rasd:ResourceSubType>
        <rasd:ResourceType>5</rasd:ResourceType>
      </Item>
      <Item>
        <rasd:AddressOnParent>0</rasd:AddressOnParent>
        <rasd:Caption>disk1</rasd:Caption>
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

cd "${OVA_DIR}"
sha256sum "${NAME}.ovf" "${NAME}-disk1.vmdk" | sed 's/ / = SHA256(/' | sed 's/$/)/' > "${NAME}.mf"
tar cf "/output/${NAME}.ova" "${NAME}.ovf" "${NAME}-disk1.vmdk" "${NAME}.mf"
cd /
rm -rf "${OVA_DIR}"

OVA_SIZE=$(du -h "/output/${NAME}.ova" | cut -f1)
echo "  OVA:   ${NAME}.ova (${OVA_SIZE})"

# Cleanup
rm -rf "${GENIMAGE_TMP}" "${MOUNT_DIR}"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   LLM OS Micro — Build complete!    ║"
echo "║                                      ║"
echo "║   QCOW2: ${QCOW2_SIZE} (Proxmox/KVM)        ║"
echo "║   VHDX:  ${VHDX_SIZE} (Hyper-V)              ║"
echo "║   OVA:   ${OVA_SIZE} (VirtualBox)            ║"
echo "║                                      ║"
echo "║   Boot, then: http://<ip>:3000      ║"
echo "║   SSH: root / llmos                  ║"
echo "╚══════════════════════════════════════╝"
