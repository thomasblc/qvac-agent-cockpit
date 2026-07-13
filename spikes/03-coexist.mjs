// P0 spike 03: voice + embedding models in-process WHILE the serve runs + an ACP prompt works.
import { loadModel, unloadModel, textToSpeech, transcribe, embed, PARAKEET_TDT_0_6B_V3_Q8_0, TTS_EN_SUPERTONIC_Q8_0, EMBEDDINGGEMMA_300M_Q4_0 } from "@qvac/sdk";
const t = (n, s) => console.log(n, ((Date.now() - s) / 1000).toFixed(1) + "s");
let s = Date.now();
const asr = await loadModel({ modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0, modelType: PARAKEET_TDT_0_6B_V3_Q8_0.engine, modelConfig: { maxThreads: 4, useGPU: true, sampleRate: 16000, channels: 1 } }); t("parakeet", s);
s = Date.now();
const tts = await loadModel({ modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelType: TTS_EN_SUPERTONIC_Q8_0.engine, modelConfig: { ttsEngine: "supertonic", language: "en", voice: "F1", ttsSpeed: 1.05, ttsNumInferenceSteps: 5 } }); t("supertonic", s);
s = Date.now();
const emb = await loadModel({ modelSrc: EMBEDDINGGEMMA_300M_Q4_0, modelType: EMBEDDINGGEMMA_300M_Q4_0.engine, modelConfig: { verbosity: 0 } }); t("embeddinggemma", s);
s = Date.now();
const audio = await textToSpeech({ modelId: tts, text: "coexistence check", inputType: "text", stream: false }).buffer;
const vec = (await embed({ modelId: emb, text: "coexistence" })).embedding;
t("synth+embed", s);
console.log("audio samples:", audio.length, "| embed dim:", vec.length);
const r = await fetch("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "qwen3.6-moe", messages: [{ role: "user", content: "Say COEXIST" }], max_tokens: 5 }) }).then((r) => r.json());
console.log("serve during residency:", JSON.stringify(r.choices?.[0]?.message?.content));
for (const id of [asr, tts, emb]) await unloadModel({ modelId: id, clearStorage: false }).catch(() => {});
console.log(audio.length > 10000 && vec.length === 768 && r.choices ? "SPIKE03 PASS" : "SPIKE03 FAIL");
process.exit(0);
