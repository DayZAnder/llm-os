// Chromium Browser — known app template
// Full web browser running Chromium in Docker with KasmVNC for high-performance web streaming.
// KasmVNC replaces xvfb + x11vnc + novnc + websockify with a single binary:
//   - Built-in Xvnc server (X display + VNC encoder + web server)
//   - WebP/JPEG adaptive encoding (much faster than raw VNC framebuffer)
//   - Built-in web client (no separate noVNC needed)
//   - Clipboard sync, dynamic resolution, file transfer sidebar

export const CHROMIUM_BROWSER = {
  name: 'Web Browser',
  type: 'process',
  description: 'Chromium web browser with KasmVNC streaming',
  capabilities: [
    'process:network',
  ],
  dockerfile: `FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \\
    chromium \\
    dbus-x11 \\
    fonts-liberation \\
    fonts-noto-color-emoji \\
    procps \\
    supervisor \\
    wget \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/*

# Install KasmVNC — single binary replaces xvfb + x11vnc + novnc + websockify
RUN wget -q "https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_bookworm_1.4.0_amd64.deb" \\
    -O /tmp/kasmvnc.deb \\
    && dpkg -i /tmp/kasmvnc.deb || true \\
    && apt-get update && apt-get install -y -f --no-install-recommends \\
    && rm /tmp/kasmvnc.deb && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -r browser && useradd -r -g browser -m -s /bin/bash browser

# Setup directories
RUN mkdir -p /home/browser/.config/chromium /tmp/.X11-unix \\
    && chown -R browser:browser /home/browser \\
    && chmod 1777 /tmp/.X11-unix

# KasmVNC config (disable SSL for container-internal HTTP)
COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml

# Supervisor config
COPY supervisord.conf /etc/supervisor/conf.d/browser.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/entrypoint.sh"]`,
  containerConfig: {
    port: 3001,
    title: 'Web Browser',
    env: [],
    contextFiles: {
      'kasmvnc.yaml': `network:
  protocol: http
  interface: 0.0.0.0
  websocket_port: 3001
  ssl:
    require_ssl: false
desktop:
  resolution:
    width: 1280
    height: 900
  allow_resize: true
encoding:
  max_frame_rate: 60
  rect_encoding_mode:
    min_quality: 7
    max_quality: 8
    consider_lossless_quality: 10
    rectangle_compress_threads: 0
keyboard:
  raw_keyboard: true
`,
      'supervisord.conf': `[supervisord]
nodaemon=true
user=root
logfile=/dev/stdout
logfile_maxbytes=0

[program:kasmvnc]
command=Xvnc :1 -geometry 1280x900 -depth 24 -websocketPort 3001 -interface 0.0.0.0 -httpd /usr/share/kasmvnc/www -disableBasicAuth -SecurityTypes None -AlwaysShared -ac
autorestart=true
priority=10
user=browser
environment=HOME="/home/browser"
startsecs=2

[program:chromium]
command=chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-software-rasterizer --window-size=1280,860 --window-position=0,0 --no-first-run --disable-default-apps --disable-infobars --start-maximized
autorestart=true
priority=20
user=browser
environment=DISPLAY=":1",HOME="/home/browser"
startsecs=3
`,
      'entrypoint.sh': `#!/bin/bash
set -e

# Start dbus
mkdir -p /run/dbus
dbus-daemon --system --fork 2>/dev/null || true

# Fix permissions
chown -R browser:browser /home/browser
chmod 1777 /tmp/.X11-unix

echo "Web Browser (KasmVNC) starting on http://0.0.0.0:3001"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/browser.conf
`,
    },
  },
  setupInstructions: 'Full Chromium browser with KasmVNC streaming. Click to interact. Use the sidebar for clipboard and settings.',
};
