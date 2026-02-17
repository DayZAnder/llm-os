// Claude (Anthropic) provider
// Endpoint: POST https://api.anthropic.com/v1/messages

export const provider = {
  name: 'claude',

  isAvailable(providerConfig) {
    return !!providerConfig.apiKey;
  },

  async checkHealth(providerConfig) {
    return !!providerConfig.apiKey;
  },

  async generate(messages, providerConfig, options = {}) {
    // Anthropic separates system prompt from messages
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');

    const body = {
      model: providerConfig.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: userMessages,
    };
    if (systemMsg) body.system = systemMsg.content;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': providerConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Claude error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text;
  },
};
