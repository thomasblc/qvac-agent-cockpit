// Tiny stopword language detector for the AUTO voice mode (en/fr/es/de/it).
// Ported from the coffee-conversation demo's lessons:
//  - French ELISIONS (j', qu', c'est, est-ce) are near-unique and decisive; plain shared
//    function words (que, tu, me, con, una) must NOT discriminate (they caused fr->es flips).
//  - Normalize apostrophe variants first (Parakeet can emit curly quotes).
//  - STICKY: keep the current language unless another beats it by a clear margin, so one
//    short ambiguous utterance cannot flip the conversation voice.
const STRONG = {
  fr: /(\bj'|\bqu'|\bm'\s|\bn'\s|c'est|est-ce|s'il|\baujourd'hui\b|\bvoilà\b|\bmerci\b|\bbonjour\b|\bheure\b|\bmaintenant\b)/,
  es: /(\b¿|\bpor favor\b|\bgracias\b|\bahora\b|\bhola\b|\busted\b|\bmañana\b|\btiempo\b|\bqué\b)/,
  de: /(\bich\b|\bnicht\b|\bund\b|\bbitte\b|\bdanke\b|\bjetzt\b|\bwie\b|\bwetter\b|\buhr\b|\bheute\b)/,
  it: /(\bgrazie\b|\badesso\b|\bciao\b|\bper favore\b|\boggi\b|\bche ore\b|\btempo\b|\bcome stai\b)/,
  en: /(\bthe\b|\bwhat\b|\bplease\b|\bnow\b|\btoday\b|\bweather\b|\btime\b|\bhow\b|\bcan you\b|\bhello\b|\bhi\b)/,
};
const WORDS = {
  fr: ["le", "la", "les", "des", "une", "est", "dans", "pour", "avec", "tu", "vous", "je", "il", "elle", "ne", "pas", "sur", "ce", "cette", "moi"],
  es: ["el", "los", "las", "una", "es", "en", "para", "con", "yo", "usted", "no", "este", "esta", "como", "donde", "cuando", "muy", "mi"],
  de: ["der", "die", "das", "ein", "eine", "ist", "im", "mit", "du", "sie", "kein", "auf", "was", "wo", "wann", "sehr", "mein", "dein"],
  it: ["il", "lo", "gli", "una", "è", "nel", "per", "con", "io", "lei", "non", "questo", "questa", "come", "dove", "quando", "molto", "mio"],
  en: ["the", "a", "an", "is", "in", "for", "with", "you", "i", "it", "not", "this", "that", "how", "where", "when", "very", "my", "of", "to"],
};
export const DETECT_LANGS = Object.keys(WORDS);

function scoreOf(text, lang) {
  let s = 0;
  if (STRONG[lang].test(text)) s += 3;
  const tokens = text.split(/[^a-zà-ÿäöüß¿¡']+/);
  const set = new Set(WORDS[lang]);
  for (const t of tokens) if (set.has(t)) s += 1;
  return s;
}

// Detect the language of `text`. Sticky: returns `current` unless another language
// beats it by >= margin. Short/empty text always keeps `current`.
export function decideLanguage(text, current = "en", margin = 3) {
  const t = String(text || "").toLowerCase().replace(/[‘’ʼ`]/g, "'").trim();
  if (t.split(/\s+/).length < 2) return current;
  const scores = {};
  for (const l of DETECT_LANGS) scores[l] = scoreOf(t, l);
  let best = current, bestScore = scores[current] ?? 0;
  for (const l of DETECT_LANGS) if (scores[l] > bestScore) { best = l; bestScore = scores[l]; }
  if (best === current) return current;
  return bestScore - (scores[current] ?? 0) >= margin ? best : current;
}
