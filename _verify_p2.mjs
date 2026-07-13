// P2 gate: French speech in -> transcript -> agent turn -> spoken French audio out.
import WebSocket from "ws";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
// French utterance via macOS say (CORE pattern)
const aiff = join(tmpdir(), "p2.aiff"), wav = join(tmpdir(), "p2.wav"), raw = join(tmpdir(), "p2.raw");
spawnSync("say", ["-v", "Thomas", "-o", aiff, "Bonjour, peux tu me dire simplement bonjour en retour"], { stdio: "ignore" });
spawnSync("ffmpeg", ["-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", raw], { stdio: "ignore" });
const pcm = readFileSync(raw);
console.log("mic frame:", pcm.length, "bytes");
const ws = new WebSocket("ws://localhost:8150");
ws.binaryType = "arraybuffer";
let transcriptText = "", lang = null, audioBytes = 0, spokeEnd = false, finalText = "";
const done = new Promise((res) => {
  ws.on("open", () => setTimeout(() => ws.send(pcm), 500));
  ws.on("message", (buf, isBinary) => {
    if (isBinary) { audioBytes += (buf.byteLength ?? buf.length ?? 0); return; }
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.type === "userTranscript") { transcriptText = m.text; console.log("  transcript:", JSON.stringify(m.text)); }
    if (m.type === "langSwitched") lang = m.lang;
    if (m.type === "final") finalText = m.text;
    if (m.type === "speakEnd") { spokeEnd = true; res(); }
    if (m.type === "error") console.log("  err:", m.message);
  });
});
await Promise.race([done, new Promise((r) => setTimeout(r, 300000))]);
ws.close();
console.log("lang:", lang, "| final:", JSON.stringify(finalText.slice(0, 80)));
console.log("speech out:", audioBytes, "bytes | speakEnd:", spokeEnd);
const frenchIn = /bonjour/i.test(transcriptText);
const pass = frenchIn && lang === "fr" && audioBytes > 40000 && spokeEnd;
console.log(pass ? "P2 GATE PASS" : "P2 GATE FAIL");
process.exit(pass ? 0 : 1);
