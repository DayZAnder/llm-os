// Errors every provider throws the same way, so the gateway can tell them
// apart from outages. Neither is retried on a fallback provider: the same
// request would be cut off or declined again — and billed twice.

/** The answer hit the output limit. `partial` holds what was written. */
export class TruncatedOutputError extends Error {
  constructor(partial, message = 'Model output hit max_tokens and was truncated') {
    super(message);
    this.name = 'TruncatedOutputError';
    this.partial = partial;
  }
}

/** The model declined to answer. */
export class RefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefusalError';
  }
}
