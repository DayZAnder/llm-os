// Ollama provider — local LLM inference
// Endpoint: POST ${url}/api/generate

export const provider = {
  name: 'ollama',

  isAvailable(providerConfig) {
    return !!providerConfig.url;
  },

  async checkHealth(providerConfig) {
    try {
      const res = await fetch(`${providerConfig.url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async generate(messages, providerConfig, options = {}) {
    // Ollama uses a single prompt string, not messages array
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsg = messages.find(m => m.role === 'user');
    const prompt = systemMsg
      ? `${systemMsg.content}\n\nUser request: ${userMsg.content}`
      : userMsg.content;

    let res;
    try {
      res = await fetch(`${providerConfig.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: providerConfig.model,
          prompt,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.4,
            num_predict: options.maxTokens ?? 4096,
          },
        }),
      });
    } catch (err) {
      const url = providerConfig.url;
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
        throw new Error(`Cannot reach Ollama at ${url} — is it running? Check OLLAMA_URL in .env`);
      }
      throw new Error(`Ollama connection failed (${url}): ${err.message}`);
    }

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 && text.includes('not found')) {
        throw new Error(`Model "${providerConfig.model}" not found. Run: ollama pull ${providerConfig.model}`);
      }
      throw new Error(`Ollama error: ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.response;
  },
};
