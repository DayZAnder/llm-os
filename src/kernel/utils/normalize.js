// Normalize a user prompt for deduplication and fuzzy matching.
// Used by the app registry to find similar previously-generated apps.

const FILLER_WORDS = new Set([
  'please', 'can', 'you', 'could', 'would', 'i', 'want', 'need',
  'make', 'me', 'build', 'create', 'generate', 'give', 'write',
  'get', 'show', 'just', 'simple', 'basic', 'like', 'something',
]);

const ARTICLES = new Set(['a', 'an', 'the', 'this', 'that', 'some']);

export function normalizePrompt(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')         // strip punctuation
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
    .split(' ')
    .filter(w => !ARTICLES.has(w) && !FILLER_WORDS.has(w))
    .join(' ');
}

// Trigram similarity (Dice coefficient) between two strings.
// Returns 0-1 where 1 is identical.
export function trigramSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) {
    // Fall back to simple inclusion check for very short strings
    return a.includes(b) || b.includes(a) ? 0.5 : 0;
  }

  const trigramsA = getTrigrams(a);
  const trigramsB = getTrigrams(b);

  let intersection = 0;
  for (const tri of trigramsA) {
    if (trigramsB.has(tri)) intersection++;
  }

  return (2 * intersection) / (trigramsA.size + trigramsB.size);
}

function getTrigrams(str) {
  const padded = `  ${str} `;
  const trigrams = new Set();
  for (let i = 0; i <= padded.length - 3; i++) {
    trigrams.add(padded.slice(i, i + 3));
  }
  return trigrams;
}

// Estimate token count (cl100k_base approximation).
// Rough heuristic: ~4 chars per token, adjusted for whitespace.
export function estimateTokenCount(text) {
  // Count words and non-word segments separately
  const words = text.split(/\s+/).filter(Boolean);
  let tokens = 0;
  for (const word of words) {
    // Most common words (≤12 chars) are single tokens in cl100k_base.
    // Only very long words get split into multiple tokens.
    if (word.length <= 12) tokens += 1;
    else tokens += Math.ceil(word.length / 4);
  }
  return Math.max(1, tokens);
}
