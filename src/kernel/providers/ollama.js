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

    const res = await fetch(`${providerConfig.url}/api/generate`, {
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

    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.response;
  },
};
