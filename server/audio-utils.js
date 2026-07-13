// Audio helpers for QVAC CORE. Adapted from the QVAC SDK tts/utils example.
// 16-bit PCM WAV writing + cross-platform playback for headless tests.

import { writeFileSync, unlinkSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { platform, tmpdir } from "os";
import { join } from "path";

// Create a 44-byte WAV header for mono 16-bit PCM at the given sample rate.
export function createWavHeader(dataLength, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// Convert an Int16Array (or array) of samples to a little-endian buffer.
export function int16ArrayToBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

// Write samples to a .wav file.
export function createWav(samples, sampleRate, filename) {
  const audioData = int16ArrayToBuffer(samples);
  const wavHeader = createWavHeader(audioData.length, sampleRate);
  writeFileSync(filename, Buffer.concat([wavHeader, audioData]));
  return filename;
}

// Generate a test WAV from text using macOS `say` + ffmpeg (16k mono f32le),
// the format QVAC Whisper expects. Returns the wav path. macOS only (test aid).
export function sayToWav(text, voice) {
  const stamp = `${process.pid}-${Math.round(process.hrtime()[1])}`;
  const aiff = join(tmpdir(), `qvac-say-${stamp}.aiff`);
  const wav = join(tmpdir(), `qvac-say-${stamp}.wav`);
  const sayArgs = voice ? ["-v", voice, "-o", aiff, text] : ["-o", aiff, text];
  let r = spawnSync("say", sayArgs, { stdio: "ignore" });
  if (r.status !== 0) throw new Error("macOS `say` failed");
  r = spawnSync("ffmpeg", ["-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_f32le", wav], { stdio: "ignore" });
  if (r.status !== 0) throw new Error("ffmpeg conversion failed");
  try { unlinkSync(aiff); } catch {}
  return wav;
}

// Play a full WAV buffer via ffplay (cross-platform, ships with ffmpeg).
export function playWavBuffer(wavBuffer) {
  const result = spawnSync("ffplay", ["-hide_banner", "-loglevel", "error", "-autoexit", "-nodisp", "-i", "pipe:0"], {
    input: wavBuffer,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw new Error(`ffplay failed: ${result.error.message}`);
}

// Play one Int16 PCM chunk by writing a temp WAV and shelling to the OS player.
// Sequential when awaited in order, suitable for streaming TTS.
export function playPcmInt16Chunk(samples, sampleRate) {
  if (!samples || samples.length === 0) return Promise.resolve();
  const audioData = int16ArrayToBuffer(samples);
  const wavFile = Buffer.concat([createWavHeader(audioData.length, sampleRate), audioData]);
  const tempFile = join(tmpdir(), `qvac-tts-chunk-${process.pid}-${Math.round(process.hrtime()[1])}.wav`);
  writeFileSync(tempFile, wavFile);
  const p = platform();
  const player = p === "darwin" ? "afplay" : p === "win32" ? "powershell" : "aplay";
  const args = p === "win32"
    ? ["-Command", `(New-Object Media.SoundPlayer '${tempFile}').PlaySync()`]
    : [tempFile];
  return new Promise((resolve, reject) => {
    const proc = spawn(player, args, { stdio: "ignore" });
    proc.on("error", (err) => { try { unlinkSync(tempFile); } catch {} reject(err); });
    proc.on("close", () => { try { unlinkSync(tempFile); } catch {} resolve(); });
  });
}
