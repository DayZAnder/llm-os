// Claude (Anthropic) provider
// Endpoint: POST https://api.anthropic.com/v1/messages (streaming SSE)
//
// Raw fetch instead of the SDK to keep the kernel dependency-free.
// Streaming is used for every request: full single-file apps can take
// minutes to generate, and a non-streaming request would sit silent until
// Node's 5-minute header timeout kills it.

// Models that support the server-side refusal fallback (`fallbacks: "default"`).
// A classifier false positive then re-runs on a recommended model instead of
// failing the generation.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

import { TruncatedOutputError, RefusalError } from './errors.js';
export { TruncatedOutputError };

/** Parse an SSE byte stream into {event, data} objects. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (raw) => {
    let event = 'message', data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return data ? { event, data: JSON.parse(data) } : null;
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const ev = parse(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (ev) yield ev;
    }
  }
  // A last event without the trailing blank line
  buf += decoder.decode();
  const last = buf.trim() && parse(buf.trim());
  if (last) yield last;
}

export const provider = {
  name: 'claude',

  isAvailable(providerConfig) {
    return !!providerConfig.apiKey;
  },

  async checkHealth(providerConfig) {
    return !!providerConfig.apiKey;
  },

  /**
   * @param {Array<{role, content}>} messages — system messages are lifted into
   *   the `system` field; the first one is marked cacheable (stable prefix),
   *   later ones (per-request context) follow it uncached.
   * @param {object} options — { maxTokens, onText(chunk, totalChars), effort }
   * @returns {Promise<string>} the generated text
   */
  async generate(messages, providerConfig, options = {}) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convo = messages.filter(m => m.role !== 'system');
    const model = providerConfig.model;

    const body = {
      model,
      max_tokens: options.maxTokens ?? 64000,
      stream: true,
      messages: convo,
    };
    if (systemMsgs.length) {
      body.system = systemMsgs.map((m, i) => ({
        type: 'text',
        text: m.content,
        ...(i === 0 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
    }
    const effort = options.effort || providerConfig.effort;
    if (effort) body.output_config = { effort };

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': providerConfig.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (FALLBACK_MODELS.has(model)) {
      body.fallbacks = 'default';
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`Claude error: ${res.status} ${await res.text()}`);

    let text = '';
    let stopReason = null;
    let stopDetails = null;
    let stopped = false;
    let usage = {};
    for await (const { data } of sseEvents(res.body)) {
      switch (data.type) {
        case 'message_start':
          usage = { ...data.message?.usage };
          break;
        case 'content_block_start':
          // A fallback block means the first model declined mid-stream and a
          // fallback model continues. Discard the declined partial output.
          if (data.content_block?.type === 'fallback') { text = ''; options.onReset?.(); }
          break;
        case 'content_block_delta':
          if (data.delta?.type === 'text_delta') {
            text += data.delta.text;
            options.onText?.(data.delta.text, text.length);
          }
          break;
        case 'message_delta':
          stopReason = data.delta?.stop_reason ?? stopReason;
          stopDetails = data.delta?.stop_details ?? stopDetails;
          if (data.usage) usage = { ...usage, ...data.usage };
          break;
        case 'message_stop':
          stopped = true;
          break;
        case 'error':
          throw new Error(`Claude stream error: ${data.error?.type} ${data.error?.message}`);
      }
    }

    options.onUsage?.({
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    });
    if (stopReason === 'refusal') {
      const why = stopDetails?.explanation || stopDetails?.category || 'no details';
      throw new RefusalError(`Claude declined the request (${why})`);
    }
    if (stopReason === 'max_tokens') throw new TruncatedOutputError(text);
    // A connection that closed cleanly before the end must not pass a
    // half-written app off as finished.
    if (!stopped || !stopReason) throw new Error('Claude stream ended before the answer was complete');
    return text;
  },
};
