# Third-Party Licenses

## LLM OS Project Code

All code in `src/`, `scripts/`, `site/`, `tests/`, `examples/`, and `build/` (build configs, overlay scripts) is original work licensed under the **MIT License** — see [LICENSE](LICENSE).

The LLM OS kernel runs in userspace on Node.js. It is not a derivative work of the Linux kernel. The syscall boundary is explicitly excluded from GPL scope per the Linux kernel's COPYING file.

## VM Image Components

The downloadable VM images (Server, Desktop, Micro) bundle third-party open-source components. These are compiled from upstream sources at build time — no third-party source code is checked into this repository.

### GPL v2 Components

Per GPL v2 Section 3(b), source code for all GPL components can be obtained from their upstream projects listed below.

| Component | Version | License | Variants | Upstream Source |
|-----------|---------|---------|----------|-----------------|
| Linux kernel | 6.12.10 (Micro), LTS (Server/Desktop) | GPL-2.0 | All | https://kernel.org |
| Busybox | Buildroot default | GPL-2.0 | Micro | https://busybox.net |
| Syslinux | 6.03 | GPL-2.0 | All | https://syslinux.org |
| Git | Alpine package | GPL-2.0 | Server, Desktop | https://git-scm.com |
| iptables | Alpine package | GPL-2.0 | Server, Desktop | https://netfilter.org |
| e2fsprogs | Alpine/Buildroot | GPL-2.0 | All | https://e2fsprogs.sourceforge.net |
| Bash | Alpine package | GPL-3.0 | Server, Desktop | https://www.gnu.org/software/bash/ |
| util-linux | Alpine package | GPL-2.0+ | Server, Desktop | https://github.com/util-linux/util-linux |

### MIT / BSD / Permissive Components

| Component | Version | License | Variants | Upstream |
|-----------|---------|---------|----------|----------|
| Node.js | 22.13.1 | MIT | All | https://nodejs.org |
| musl libc | Buildroot default | MIT | Micro | https://musl.libc.org |
| Alpine Linux | 3.21 | MIT (APK tools) | Server, Desktop | https://alpinelinux.org |
| OpenRC | Alpine package | BSD-2-Clause | Server, Desktop | https://github.com/OpenRC/openrc |
| Dropbear SSH | Buildroot package | MIT | Micro | https://matt.ucc.asn.au/dropbear/ |
| OpenSSH | Alpine package | BSD | Server, Desktop | https://openssh.com |
| Chromium | Alpine package | BSD-3-Clause | Desktop | https://chromium.org |
| Cage | Alpine package | MIT | Desktop | https://github.com/cage-kiosk/cage |
| Seatd | Alpine package | MIT | Desktop | https://sr.ht/~kennylevinsen/seatd/ |

### Apache 2.0 Components

| Component | Version | License | Variants | Upstream |
|-----------|---------|---------|----------|----------|
| Docker Engine | Alpine package | Apache-2.0 | Server, Desktop | https://docker.com |
| OpenSSL | Alpine/Buildroot | Apache-2.0 | All | https://openssl.org |

### Other

| Component | Version | License | Variants | Upstream |
|-----------|---------|---------|----------|----------|
| CA Certificates | System package | MPL-2.0 | All | https://curl.se/docs/caextract.html |
| Noto Fonts | Alpine package | OFL-1.1 | Desktop | https://fonts.google.com/noto |
| DejaVu Fonts | Alpine package | Bitstream Vera | Desktop | https://dejavu-fonts.github.io |
| zlib | Buildroot package | Zlib | Micro | https://zlib.net |

## Build Tools (not distributed)

Buildroot (GPL-2.0), GCC (GPL-3.0), and Debian build containers are used during the build process but are **not included** in the distributed VM images.

## Obtaining Source Code

For any GPL-licensed component included in the VM images, source code is available from the upstream URLs listed above. The exact versions used can be determined from:
- **Micro**: `build/buildroot/configs/llmos_micro_defconfig` (kernel version, Buildroot package versions)
- **Server/Desktop**: `build/build-vm.sh` (Alpine package list)

If you need specific source packages matching a particular release, open an issue on [GitHub](https://github.com/DayZAnder/llm-os/issues) and we will provide them.
