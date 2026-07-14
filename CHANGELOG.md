# Changelog

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
