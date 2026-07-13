// Pure text/vector utils: the ENTIRE chunking/cosine/topKPairs block lifted verbatim
// from Second Self lib/models.js (constants + private helpers included).

const MAX_WORD_CHARS = 800;   // a single token longer than this is split before chunking
// The embedder rejects any input line over 1024 TOKENS ("batch overflow: ... exceeds batch size
// (1024)"), and the limit cannot be raised via load config (the embedding schema rejects n_batch).
// Tokens-per-char varies (dense French markdown measured ~2.1 chars/token; CJK ~1), so cap chunks at
// 950 CHARS: that stays under 1024 tokens for any realistic content, incl. accents/markdown/CJK.
const MAX_CHUNK_CHARS = 950;
function splitLongWords(words) {
  const out = [];
  for (const w of words) {
    if (w.length <= MAX_WORD_CHARS) out.push(w);
    else for (let i = 0; i < w.length; i += MAX_WORD_CHARS) out.push(w.slice(i, i + MAX_WORD_CHARS));
  }
  return out;
}
function capChunk(s) {
  if (s.length <= MAX_CHUNK_CHARS) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += MAX_CHUNK_CHARS) out.push(s.slice(i, i + MAX_CHUNK_CHARS));
  return out;
}

export function chunkText(doc, wordsPerChunk = 120, overlap = 20) {
  const body = String(doc || "").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  if (!body) return [];
  const rawWords = body.split(/\s+/);
  const words = splitLongWords(rawWords); // identity unless a single token exceeds MAX_WORD_CHARS
  // fast path: a short doc with no oversized token returns its text verbatim - byte-for-byte the
  // same as before this guard existed, so existing indexes don't re-chunk on reindex.
  if (words.length === rawWords.length && rawWords.length <= wordsPerChunk) return capChunk(body);
  const raw = [];
  if (words.length <= wordsPerChunk) raw.push(words.join(" "));
  else {
    const step = Math.max(1, wordsPerChunk - overlap);
    for (let i = 0; i < words.length; i += step) {
      raw.push(words.slice(i, i + wordsPerChunk).join(" "));
      if (i + wordsPerChunk >= words.length) break;
    }
  }
  return raw.flatMap(capChunk); // final safety net for whitespace-sparse chunks
}

// Cosine similarity for the graph's semantic edges.
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Top-K nearest neighbors per item -> dedup pairs for "embed" edges.
export function topKPairs(ids, vectors, k = 4, minScore = 0.55) {
  const pairs = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const sims = [];
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      sims.push([j, cosine(vectors[i], vectors[j])]);
    }
    sims.sort((x, y) => y[1] - x[1]);
    for (const [j, score] of sims.slice(0, k)) {
      if (score < minScore) break;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: ids[i], b: ids[j], score });
    }
  }
  return pairs;
}
