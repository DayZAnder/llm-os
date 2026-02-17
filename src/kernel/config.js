import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env file if it exists
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

export const config = {
  ollama: {
    url: process.env.OLLAMA_URL || 'http://192.168.2.183:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:14b',
  },
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929',
  },
  port: parseInt(process.env.PORT || '3000', 10),
  docker: {
    enabled: process.env.DOCKER_ENABLED !== 'false',
    host: process.env.DOCKER_HOST || '',
    portStart: parseInt(process.env.DOCKER_PORT_START || '5100', 10),
    portEnd: parseInt(process.env.DOCKER_PORT_END || '5199', 10),
    maxContainers: parseInt(process.env.DOCKER_MAX_CONTAINERS || '5', 10),
  },
  scheduler: {
    enabled: process.env.SCHEDULER_ENABLED === 'true',
    deferMs: parseInt(process.env.SCHEDULER_DEFER_MINUTES || '5', 10) * 60000,
    provider: process.env.SCHEDULER_PROVIDER || 'ollama',
    dailyBudget: parseInt(process.env.SCHEDULER_DAILY_BUDGET || '30', 10),
    maxRegistryApps: parseInt(process.env.SCHEDULER_MAX_REGISTRY || '500', 10),
  },
};
