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
    // Stream only when someone is watching (live generation view)
    const stream = !!options.onText;
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
        max_tokens: options.maxTokens ?? 16384,
        stream,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);

    if (!stream) {
      const data = await res.json();
      if (data.usage) {
        // cached_tokens are a subset of prompt_tokens with provider-specific
        // discounts; count them as plain input (an upper bound).
        options.onUsage?.({
          inputTokens: data.usage.prompt_tokens || 0,
          outputTokens: data.usage.completion_tokens || 0,
        });
      }
      const choice = data.choices[0];
      if (choice.finish_reason === 'length') throw new Error('OpenAI output truncated (max_tokens reached)');
      return choice.message.content;
    }

    // SSE: "data: {choices:[{delta:{content}, finish_reason}]}" … "data: [DONE]"
    const decoder = new TextDecoder();
    let buf = '', text = '', finish = null;
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        const choice = JSON.parse(payload).choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          options.onText(delta, text.length);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
    }
    if (finish === 'length') throw new Error('OpenAI output truncated (max_tokens reached)');
    return text;
  },
};
