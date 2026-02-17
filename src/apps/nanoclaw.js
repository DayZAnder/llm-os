// NanoClaw — known app template
// When user types "run nanoclaw", we skip LLM generation and use this directly.

export const NANOCLAW = {
  name: 'NanoClaw',
  type: 'process',
  description: 'Lightweight Claude AI assistant with WhatsApp integration',
  capabilities: [
    'process:background',
    'process:network',
    'process:volume',
    'api:anthropic',
  ],
  dockerfile: `FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    chromium libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1 \\
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r nanoclaw && useradd -r -g nanoclaw -m nanoclaw

WORKDIR /app

RUN npm install -g @anthropic-ai/claude-code

RUN git clone --depth 1 https://github.com/qwibitai/nanoclaw.git . \\
    && npm ci --only=production

RUN mkdir -p /app/groups /app/data && chown -R nanoclaw:nanoclaw /app

USER nanoclaw

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3001

CMD ["npm", "start"]`,
  containerConfig: {
    port: 3001,
    title: 'NanoClaw',
    env: [],
  },
  setupInstructions: 'After launching, scan the QR code displayed in the logs with WhatsApp to connect.',
};

// Known apps registry
export const KNOWN_APPS = {
  nanoclaw: NANOCLAW,
};

/**
 * Check if a prompt matches a known app.
 * Returns the app template or null.
 */
export function matchKnownApp(prompt) {
  const lower = prompt.toLowerCase().trim();
  for (const [key, app] of Object.entries(KNOWN_APPS)) {
    if (lower.includes(key) || lower === `run ${key}`) {
      return app;
    }
  }
  return null;
}
