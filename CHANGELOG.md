# Changelog

## 2.4.0 (2026-07-15) - UI polish
- Settings now uses the full width (responsive multi-column grid) instead of a narrow 40%-wide column.
- Top bar cleaned up: removed the empty model dropdown, capability badges are now legible pills (only what's supported, with a single muted "no ..." pill for the rest) next to the agent name, tidier spacing.
- Skills pane: grouped by source, each skill shows a ready / needs-setup status, with a one-line explanation that it's a read-only view of OpenClaw's skill catalog.

## 2.3.0 (2026-07-14) - use your own local models (no re-download)
- New **Local models** setting: point at a folder of GGUF files you already have (LM Studio, Ollama, manual HF downloads), Scan it, and Add them - they show up in the model picker and load straight from disk, no re-download. Proven: `qvac serve` accepts an explicit `{ src: <local path>, type }` model entry, so the cockpit generates a merged serve config (bundled catalog models + your local ones) that the serve points at.
- Also: QVAC's own downloaded models (in ~/.qvac) are already reused across runs - re-download only happens for a catalog model you have never fetched.
- Scan is bounded and skips multi-shard GGUFs (v1); single-file GGUFs only.

## 2.2.0 (2026-07-14) - Setup wizard (install + provider, no CLI)
- New **Setup** card that gets OpenClaw running from scratch without a terminal: it detects what's missing and offers **Install OpenClaw** (npm i -g openclaw + @qvac packages, streamed live) and **Set up QVAC provider** (installs/enables the @qvac/openclaw-plugin, writes the provider config, selects the model - the exact sequence, streamed). The card hides itself once everything is ready.
- With one-click pairing (2.1) this means: install -> set up provider -> connect -> pair, all from the cockpit UI, no CLI.
- Note: model weights still download on first use of a model via the serve (no standalone progress bar yet - the QVAC CLI has no model-pull command).

## 2.1.1 (2026-07-14) - pairing fix-pack + WS origin gate
- Fix (P1): `run()` truncated command stdout to 600 chars, which corrupted the JSON that device pairing parses (`devices list --json`), so pairing silently approved nothing. Full stdout is now kept.
- Fix (P1): device pairing now approves ONLY the ACP bridge's own pending request (displayName "ACP"), not every pending request - closes a confused-deputy path where a foreign device pending at the same instant could be auto-approved.
- Security (P1): the WebSocket server now enforces an Origin gate. The cockpit does privileged things (spawn processes, grant OpenClaw admin scope, write config) and a WS handshake bypasses same-origin, so a malicious web page could otherwise drive it drive-by. Only a same-host browser Origin (the cockpit page) or no Origin (CLI/non-browser) is accepted.

## 2.1.0 (2026-07-14) - one-click device pairing
- **No more CLI to pair the device.** OpenClaw's ACP bridge needs this device paired with admin scope on the local Gateway (previously `openclaw onboard` in a terminal). Now: Connect detects the pending-scope state and offers a **Pair this device** button that approves it with the Gateway token and reconnects - all in the cockpit. Removes the last one-time CLI step for connecting to OpenClaw.
- Mechanism: the pending admin request is created when the bridge attempts to connect, so pairing = attempt -> approve the exact requestId (not --latest, which never escalates past operator.pairing) -> attempt again. Idempotent when already paired.

## 2.0.0 (2026-07-14) - OpenClaw-only
- **Focus: the cockpit is now an OpenClaw app.** Hermes was removed for now (fully integrating a harness is a lot of work; better to make one experience complete). Default + only harness is OpenClaw; the harness switcher is gone.
- The Second Brain + Files panes now default to **OpenClaw's own workspace** (agents.defaults.workspace), not the old Hermes corpus, so they show what the agent actually touches.
- New **Access & Permissions** panel that writes OpenClaw's real config with no terminal: the agent's **working folder**, the **tool profile** (minimal/coding/messaging/full), **ask-before-shell** (off/on-miss/always), and the **OS sandbox** (surfaced; container isolation needs Docker, detected automatically). Enums are allow-listed app-side; `~` is expanded.
- Settings simplified to the OpenClaw flow: one **Connect** (auto-starts the Gateway) + gateway status, governance, local model, and the vault folder.

## 1.5.0 (2026-07-14)
- **Second Brain folder is now choosable** (Settings). The Second Brain + Files panes were hardcoded to the Hermes corpus (~/.hermes) + workspace, so they showed Hermes notes even when connected to OpenClaw. Set an absolute path (a vault, ~/.openclaw/workspace, anything) and both panes index that folder recursively, Obsidian/Second-Self style. Reset returns to the default. Persisted in ~/.qvac-cockpit/config.json; the corpus path jail still applies to the chosen root.

## 1.4.0 (2026-07-14)
- **Fix (critical): the cockpit killed itself on model switch.** ServeManager/_kill reclaimed the serve port with a bare `lsof -ti tcp:PORT` (no `-sTCP:LISTEN`), which also matched the cockpit's own keep-alive client sockets to the serve, so switching the model killed the cockpit process -> "OFFLINE / connection lost", nothing worked. Now filters `-sTCP:LISTEN` (both serve + gateway managers) so only the listener is reaped. Also aligned to absolute `/usr/sbin/lsof`.
- **Settings UX rebuilt around one action.** Pick Hermes/OpenClaw (instant active state), then a single **Connect** button opens the session with real feedback (connecting -> connected / actionable error). For OpenClaw the Gateway is started for you by Connect; its card only shows when OpenClaw is selected. Model switch shows restart progress and no longer drops the connection.
- New `agent.connect` RPC (start gateway if needed -> ensureAcp), so connecting is explicit instead of a blind first message.
- Status line resets to STANDBY when the agent reconnects (was stuck on "AGENT DOWN").

## 1.3.0 (2026-07-14)
- New **Settings** pane: switch the harness (Hermes <-> OpenClaw) at runtime, start/stop the OpenClaw Gateway with a live status dot, and pick the local model. No more env vars / manual `openclaw gateway`.
- Runtime harness switch: `harness`/`caps`/`STORES` recompute together and the ACP client is dropped so the next message reconnects to the new harness. Mid-turn switch cancels pending permission cards first.
- `GatewayManager` supervises `openclaw gateway` (spawn/stop/status via the port), guarded against PID reuse on stop.
- Model picker restarts the serve with a chosen alias (qwen3.5-4b / 9b / 3.6-moe), all defined in the bundled config with tools+static. Model switch holds the serve single-flight mutex so the health watcher can't kill a still-loading model.
- Fix (self-review): `serve.setModel` now goes through the same in-flight guard as `ensure()` (was racing the 60s watcher into a double spawn/kill on the shared endpoint).

## 1.2.0 (2026-07-14)
- Second Brain: clicking a graph node now previews the doc in an in-pane side panel (rendered markdown) instead of jumping away to the Files pane, which was broken for corpus docs living outside the workspace. Click through several docs while staying in Second Brain. New read-only `brain.doc` RPC reads a corpus doc through the same path jail as link-accept.
- Second Brain resilience: a transient/empty graph rebuild no longer wipes the on-screen graph (kept the last good view + an honest status), fixing the "graph disappeared after accepting a link" report.
- Left rail is now expandable: collapsed to icons by default, expands to labelled tabs on hover, with a pin toggle (persisted) to keep it open.
- Agent replies render markdown (bold/lists/code) on completion instead of showing raw `**` and `-` (escape-first, no HTML injection).
- Fix: `brain.doc` requests passed the doc id under the `id` key, which collided with the WS envelope's own `id` and made the reply unmatchable (silent hang). Doc id now travels as `docId`.

## 1.1.0 (2026-07-13)
- OpenClaw is now a first-class second harness, driven end to end: ACP connect + text turn + tool-call turn (real file write) + a full turn in the cockpit UI, all on a local QVAC model. Approving the device (`openclaw devices approve`) unblocks the Gateway-backed ACP bridge.
- Store panes wired for OpenClaw: History (sessions) and Skills read through the OpenClaw CLI (`sessions list --json`, `skills list --json`), version-robust. OpenClaw has no Kanban/Cron store, so those panes report an honest "not available for this harness" instead of erroring.
- Per-harness capability badges in the header (the last external-audit item, P1-01): show what the connected harness exposes over ACP (session replay / plan / permission gating) and which store panes it backs. Honest tri-state (on / off / unknown).
- Fix: `history.js` `viewSession` referenced an out-of-scope `H` (would ReferenceError on any past-session view under Hermes).
- Default serve config is now bundled at `config/qvac.serve.config.json` (repo-relative), replacing a hardcoded absolute path.

## 1.0.0 (2026-07-13)
- Initial public release: six panes (Cockpit, Mission Control, Second Brain, Files, Schedule, Skills), ACP client for Hermes/OpenClaw, supervised `qvac serve openai`, gamified voice-native HUD.
- OpenClaw model connection moved to the native `@qvac/openclaw-plugin` (QVAC SDK 0.15+), replacing the hand-wired OpenAI-endpoint base_url. Verified end-to-end (`openclaw agent --local` smoke test, `finalAssistantVisibleText: "pong"`, `provider: "qvac"`, `fallbackUsed: false`).
- Pi (pi.dev) dropped from scope: no verified ACP bridge or structured-event stream against a real local binary.
- Full external-audit fix-pack applied (file jail, permission fallback, egress display honesty, onboarding secret redaction). See `README.md` for the security invariants and gates.
