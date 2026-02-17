#!/bin/sh
set -eu

# Runs inside chroot to configure the Alpine rootfs.

echo "  Installing packages..."
apk update
apk add --no-cache \
    openrc busybox-openrc \
    networkmanager networkmanager-cli dbus \
    openssh-server \
    docker docker-cli docker-compose \
    nodejs npm \
    curl git bash \
    util-linux e2fsprogs \
    iptables ip6tables

echo "  Configuring services..."

# Enable core services
rc-update add devfs sysinit
rc-update add dmesg sysinit
rc-update add mdev sysinit
rc-update add hwdrivers sysinit

rc-update add hwclock boot
rc-update add modules boot
rc-update add sysctl boot
rc-update add hostname boot
rc-update add bootmisc boot
rc-update add syslog boot
rc-update add networking boot

rc-update add docker default
rc-update add sshd default
rc-update add networkmanager default
rc-update add dbus default
rc-update add local default

rc-update add mount-ro shutdown
rc-update add killprocs shutdown
rc-update add savecache shutdown

echo "  Configuring networking..."

# DHCP on all interfaces
cat > /etc/network/interfaces << 'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
EOF

# Hostname
echo 'llmos' > /etc/hostname
echo '127.0.0.1 llmos llmos.localdomain' >> /etc/hosts

echo "  Configuring users..."

# Root password: llmos
echo 'root:llmos' | chpasswd

# SSH config
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
ssh-keygen -A 2>/dev/null || true

echo "  Configuring console..."

# Serial console for Proxmox/Hyper-V
cat > /etc/inittab << 'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default

# Console with auto-login to LLM OS status screen
tty1::respawn:/sbin/getty -n -l /usr/local/bin/llmos-login 38400 tty1
tty2::respawn:/sbin/getty 38400 tty2
tty3::respawn:/sbin/getty 38400 tty3

# Serial console (Proxmox qm terminal / Hyper-V)
ttyS0::respawn:/sbin/getty -L ttyS0 115200 vt100

::shutdown:/sbin/openrc shutdown
INITTAB

# Desktop variant: install kiosk browser packages
VARIANT="${VARIANT:-server}"
if [ "${VARIANT}" = "desktop" ]; then
    echo "  Installing kiosk browser (desktop variant)..."
    apk add --no-cache \
        chromium \
        cage seatd eudev \
        mesa-dri-gallium mesa-egl \
        font-noto ttf-dejavu
    rc-update add seatd default
fi

echo "  Generating initramfs..."
# Ensure modules for VM environments
echo 'virtio_blk' >> /etc/modules
echo 'virtio_net' >> /etc/modules
echo 'virtio_pci' >> /etc/modules
echo 'virtio_scsi' >> /etc/modules
echo 'hv_vmbus' >> /etc/modules
echo 'hv_storvsc' >> /etc/modules
echo 'hv_netvsc' >> /etc/modules
echo 'ext4' >> /etc/modules

# Rebuild initramfs with VM drivers
mkinitfs -c /etc/mkinitfs/mkinitfs.conf $(ls /lib/modules/ | head -1) 2>/dev/null || true

echo "  Rootfs setup complete."
