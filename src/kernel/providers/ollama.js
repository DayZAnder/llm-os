// Ollama provider — local LLM inference
// Endpoint: POST ${url}/api/generate

import { TruncatedOutputError } from './errors.js';

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
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system');
    // Single turn: plain request. Multi-turn (e.g. a correction round):
    // replay the conversation so the model sees its own answer and the feedback.
    const convo = turns.length === 1
      ? `User request: ${turns[0].content}`
      : turns.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n') + '\n\nAssistant:';
    const prompt = system ? `${system}\n\n${convo}` : convo;

    let res;
    try {
      res = await fetch(`${providerConfig.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: providerConfig.model,
          prompt,
          // Stream only when someone is watching (live generation view)
          stream: !!options.onText,
          options: {
            temperature: options.temperature ?? 0.4,
            num_predict: options.maxTokens ?? 16384,
            // Ollama's default context (2-4k) silently truncates the system
            // prompt + a full app. Give it room for both.
            num_ctx: options.numCtx ?? 32768,
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
    let data;
    if (options.onText) {
      // NDJSON: one {response, done, done_reason} object per line
      const decoder = new TextDecoder();
      let buf = '', text = '';
      data = {};
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const lineStr = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!lineStr) continue;
          const part = JSON.parse(lineStr);
          if (part.error) throw new Error(`Ollama error: ${part.error}`);
          if (part.response) {
            text += part.response;
            options.onText(part.response, text.length);
          }
          if (part.done) data = part;
        }
      }
      data.response = text;
    } else {
      data = await res.json();
    }
    if (data.prompt_eval_count || data.eval_count) {
      options.onUsage?.({ inputTokens: data.prompt_eval_count || 0, outputTokens: data.eval_count || 0 });
    }
    if (data.done_reason === 'length') {
      throw new TruncatedOutputError(data.response, `Ollama output truncated at ${options.maxTokens ?? 16384} tokens — try a larger model or simpler request`);
    }
    return data.response;
  },
};
