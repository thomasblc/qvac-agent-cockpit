// Voice engine for the cockpit: ears (Parakeet, multilingual auto) + voice (Supertonic,
// language is a LOAD-time config; Supertonic 3 for non-EN). Carved from QVAC CORE's
// core-engine.js WITHOUT the LLM brain (the plugged harness is the brain now).
// Models lazy-load on first voice use so text-only users pay nothing.
import {
  loadModel, unloadModel, transcribe, textToSpeech, textToSpeechStream,
  PARAKEET_TDT_0_6B_V3_Q8_0, TTS_EN_SUPERTONIC_Q8_0, TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
} from "@qvac/sdk";

export const TTS_SAMPLE_RATE = 44100;
export const SUPPORTED_LANGS = ["en", "fr", "es", "de", "it"];
const TTS_LANGS = SUPPORTED_LANGS;
const ttsLangFor = (l) => (TTS_LANGS.includes(l) ? l : "en");
const ttsBundleFor = (tl) => (tl === "en" ? TTS_EN_SUPERTONIC_Q8_0 : TTS_MULTILINGUAL_SUPERTONIC3_Q8_0);

// Strip what should never be spoken; word-case brand names (the TTS spells ALL-CAPS
// tokens letter by letter) while the transcript keeps the styled uppercase.
export function stripForSpeech(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_#`]/g, "")
    .replace(/\bQVAC\b/gi, "Q-vac")
    .replace(/\bHERMES\b/g, "Hermes")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// RMS silence gate: trim the dead air the engine pads around phrases.
const RMS_FRAME = 512, RMS_FLOOR = 400, RMS_PAD = 2;
export function trimSilence(samples) {
  if (!samples || !samples.length) return samples || new Int16Array(0);
  const frames = Math.ceil(samples.length / RMS_FRAME);
  let first = -1, last = -1;
  for (let f = 0; f < frames; f++) {
    const a = f * RMS_FRAME, b = Math.min(a + RMS_FRAME, samples.length);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / (b - a)) > RMS_FLOOR) { if (first < 0) first = f; last = f; }
  }
  if (first < 0) return new Int16Array(0);
  const from = Math.max(0, (first - RMS_PAD) * RMS_FRAME);
  const to = Math.min(samples.length, (last + 1 + RMS_PAD) * RMS_FRAME);
  return samples.subarray ? samples.subarray(from, to) : samples.slice(from, to);
}

export class VoiceEngine {
  constructor() { this.asrId = null; this.ttsId = null; this.ttsLang = null; this.language = "en"; this._loading = null; }

  _isMissingModel(e) {
    const s = String(e?.message || e);
    return /model.*(not|n't).*(found|loaded|exist)|missing model|unknown model|invalid model.?id/i.test(s) || /expected string, received null/i.test(s);
  }
  async _withReload(kind, fn) {
    try { return await fn(); }
    catch (e) {
      if (!this._isMissingModel(e)) throw e;
      if (kind === "asr") { this.asrId = null; await this.ensureASR(); }
      else { this.ttsId = null; this.ttsLang = null; await this.ensureTTS(this.language); }
      return fn();
    }
  }

  async ensureASR() {
    if (this.asrId) return this.asrId;
    this.asrId = await loadModel({
      modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0, modelType: PARAKEET_TDT_0_6B_V3_Q8_0.engine,
      modelConfig: { maxThreads: 4, useGPU: true, sampleRate: 16000, channels: 1 },
    });
    return this.asrId;
  }

  async ensureTTS(lang = "en") {
    const tl = ttsLangFor(lang);
    if (this.ttsId && this.ttsLang === tl) return this.ttsId;
    if (this.ttsId) { await unloadModel({ modelId: this.ttsId, clearStorage: false }).catch(() => {}); this.ttsId = null; }
    const bundle = ttsBundleFor(tl);
    this.ttsId = await loadModel({
      modelSrc: bundle.src ? bundle.src : bundle, modelType: bundle.engine,
      modelConfig: { ttsEngine: "supertonic", language: tl, voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 },
    });
    this.ttsLang = tl;
    this.language = tl;
    // prewarm: the first synth compiles Metal shaders; a drained throwaway keeps the
    // first real reply from being delayed (CORE lesson).
    try { await textToSpeech({ modelId: this.ttsId, text: "ready", inputType: "text", stream: false }).buffer; } catch { /* */ }
    return this.ttsId;
  }

  // audioPath: a 16k mono int16 WAV file path (Parakeet auto-detects WAV).
  async transcribeWav(audioPath) {
    await this.ensureASR();
    const out = await this._withReload("asr", () => transcribe({ modelId: this.asrId, audioChunk: audioPath }));
    return (typeof out === "string" ? out : "").trim();
  }

  // Stream speech phrase by phrase; each phrase RMS-trimmed. onChunk(Int16Array).
  async speakStream(text, onChunk) {
    const clean = stripForSpeech(text);
    if (!clean) return false;
    await this.ensureTTS(this.language);
    return this._withReload("tts", async () => {
      const session = await textToSpeechStream({ modelId: this.ttsId, inputType: "text", accumulateSentences: true });
      const drain = (async () => {
        for await (const m of session) {
          if (!m.buffer || !m.buffer.length) continue;
          const t = trimSilence(m.buffer);
          if (t.length) onChunk(t);
        }
      })();
      session.write(clean);
      session.end();
      await drain;
      return true;
    });
  }

  async unloadAll() {
    for (const id of [this.asrId, this.ttsId]) if (id) await unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
    this.asrId = this.ttsId = null; this.ttsLang = null;
  }
}
