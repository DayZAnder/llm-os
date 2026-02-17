// OpenAI-compatible provider
// Works with: OpenAI, OpenRouter, Together, Groq, vLLM, LM Studio
// Endpoint: POST ${baseUrl}/chat/completions

export const provider = {
  name: 'openai',

  isAvailable(providerConfig) {
    return !!providerConfig.apiKey;
  },

  async checkHealth(providerConfig) {
    return !!providerConfig.apiKey;
  },

  async generate(messages, providerConfig, options = {}) {
    const res = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages,
        temperature: options.temperature ?? 0.4,
        max_tokens: options.maxTokens ?? 4096,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices[0].message.content;
  },
};
