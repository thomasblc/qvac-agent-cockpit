// Local model support: point the cockpit at a folder of GGUF files you already have (LM Studio,
// Ollama exports, manual HF downloads) and use them WITHOUT re-downloading. Proven: `qvac serve`
// accepts an explicit model entry `{ src: <absolute path>, type }` (ExplicitModelEntry) where src is
// a local file path - so we scan a folder for *.gguf, let the user pick, and generate a merged serve
// config (bundled catalog models + the chosen local entries) that the ServeManager points at.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, resolve, isAbsolute } from "node:path";

const H = homedir();
const CFG = join(H, ".qvac-cockpit", "config.json");
const GENERATED = join(H, ".qvac-cockpit", "serve.config.json");

function loadCfg() { try { return JSON.parse(readFileSync(CFG, "utf8")); } catch { return {}; } }
function saveCfg(patch) {
  const cfg = loadCfg(); Object.assign(cfg, patch);
  mkdirSync(dirname(CFG), { recursive: true }); writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  return cfg;
}
function expandHome(p) { const s = String(p || "").trim(); if (!s) return ""; return s.startsWith("~") ? join(H, s.slice(1)) : (isAbsolute(s) ? s : resolve(s)); }
const alias = (name) => name.replace(/\.gguf$/i, "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 48) || "local-model";

export function getModelsFolder() { return loadCfg().modelsFolder || null; }
export function getLocalModels() { return loadCfg().localModels || []; } // [{alias, src, type, sizeMB}]

// Scan a folder (recursively, bounded) for usable single-file GGUF models. Skips multi-shard files
// (`-00001-of-00005`) since those need every shard + a .tensors.txt companion (out of scope for v1).
const MAX_DIRS = 4000;
export function scanGgufFolder(folder) {
  const root = expandHome(folder);
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) throw new Error("not a folder: " + root);
  const out = []; const stack = [root]; let dirs = 0;
  while (stack.length && dirs < MAX_DIRS && out.length < 500) {
    const dir = stack.pop(); dirs++;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(abs); continue; }
      if (!/\.gguf$/i.test(e.name)) continue;
      if (/-\d{5}-of-\d{5}\.gguf$/i.test(e.name)) continue; // shard piece: skip (v1)
      let st; try { st = statSync(abs); } catch { continue; }
      out.push({ name: e.name, path: abs, sizeMB: Math.round(st.size / 1e6) });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  saveCfg({ modelsFolder: root });
  return { folder: root, models: out };
}

// Add a local GGUF as a usable model. type defaults to the LLM engine.
export function addLocalModel({ path, type = "llamacpp-completion", alias: a } = {}) {
  const src = expandHome(path);
  if (!src || !existsSync(src) || !/\.gguf$/i.test(src)) throw new Error("not a .gguf file: " + src);
  const list = getLocalModels();
  const id = a || alias(basename(src));
  const entry = { alias: id, src, type, sizeMB: Math.round(statSync(src).size / 1e6) };
  const next = [...list.filter((m) => m.alias !== id && m.src !== src), entry];
  saveCfg({ localModels: next });
  return entry;
}
export function removeLocalModel(aliasId) {
  saveCfg({ localModels: getLocalModels().filter((m) => m.alias !== aliasId) });
  return getLocalModels();
}

// Merge the bundled base config (catalog models) with the chosen local entries into one serve config
// the ServeManager points at. Returns the generated config path. Local entries use src (local file).
export function buildServeConfig(baseConfigPath) {
  let base = {};
  try { base = JSON.parse(readFileSync(baseConfigPath, "utf8")); } catch { base = { plugins: ["@qvac/sdk/llamacpp-completion/plugin"], serve: { models: {} } }; }
  base.serve = base.serve || {}; base.serve.models = base.serve.models || {};
  for (const m of getLocalModels()) {
    base.serve.models[m.alias] = { src: m.src, type: m.type || "llamacpp-completion", config: { ctx_size: 8192, gpu_layers: -1 } };
  }
  mkdirSync(dirname(GENERATED), { recursive: true });
  writeFileSync(GENERATED, JSON.stringify(base, null, 2));
  return GENERATED;
}

// The choices the Settings model picker shows: bundled catalog defaults + local models.
export function modelChoices(catalogChoices) {
  const local = getLocalModels().map((m) => ({ id: m.alias, label: `${m.alias} (local, ~${(m.sizeMB / 1000).toFixed(1)}GB)`, local: true }));
  return [...catalogChoices, ...local];
}
