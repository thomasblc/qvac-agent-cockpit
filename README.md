# QVAC Cockpit

The best interface an agent ever had. A styled, gamified, voice-native HUD that PLUGS onto an
AI agent harness you already run (Hermes, OpenClaw), runs everything on local QVAC models,
and never sends a byte of your prompts off-device.

Not another agent. The face for the one you have. People keep hand-rolling janky mission-control
UIs for their harness; this is that layer done right.

Build history + evidence: `spikes/EVIDENCE.md` (the P0 spikes that proved the ACP round-trip,
serve coexistence, and store access before the six panes were built).

## Six panes
- **Cockpit**: talk to your agent by voice (Parakeet in, Supertonic out, auto-language) or text; streamed reply; permission prompts. The orb is your agent's avatar, its states driven by real protocol events.
- **Mission Control**: PLANNED / NOW / DONE lanes, a Needs You queue (approve permissions, unattended = deny, never auto-allow), the swarm feed, 9-profile history with full-text search + session replay, postflight debrief cards.
- **Second Brain**: a force graph of your agent's markdown, semantic links, and RAG link creation (the local model judges each proposal with a reason, then writes the `[[link]]`). Semantic edges auto-disable above `COCKPIT_SEMANTIC_MAX` docs (default 3000) rather than freezing the UI.
- **Files**: browse + edit what the agent writes, diff-first (a file changed since your last review opens against the reviewed snapshot). Jailed to the corpus roots: symlinks, hardlinks, and TOCTOU races are rejected, not just prefix-checked.
- **Schedule**: cron jobs on a timeline with a plain-language one-liner each, pause/run/remove (main profile only; other profiles are read-only in the UI).
- **Skills**: what your agent can do, with usage stats.

## How it works
- **ACP** (Agent Client Protocol) over stdio to the harness's own bridge (`hermes acp` or `openclaw acp`): structured plan / tool-call / usage events, no log parsing. One `AcpClient`, parameterized by harness (`server/acp-client.js`), not hardcoded to Hermes.
- **Model connection**: a persistent `qvac serve openai` on port 11434 (the endpoint Hermes cron depends on), health-checked by real completions and auto-restarted. For OpenClaw specifically, model connection goes through **`@qvac/openclaw-plugin`** (SDK 0.15+, native `qvac` provider that owns the `qvac serve openai` lifecycle via OpenClaw's `localService`) instead of a hand-wired OpenAI-endpoint base_url.
- **QVAC SDK 0.14.x in-process** for voice + embeddings + (P7) images. One machine, one worker, proven to coexist with the serve.

## Multi-harness status (verified 2026-07-13)
| Harness | ACP bridge (mission control) | Model connection | Store panes | Driven E2E by the cockpit |
|---|---|---|---|---|
| **Hermes** | `hermes acp`, standalone | `qvac serve openai` at `base_url` | History, Skills, Kanban, Cron (all four) | **Yes** (all gates green) |
| **OpenClaw** | `openclaw acp`, proxies the OpenClaw **Gateway** | **`@qvac/openclaw-plugin`** (native `qvac` provider) | History + Skills (via the OpenClaw CLI); no Kanban/Cron store (honest "not available") | **Yes**: connect + text turn + tool-call turn (real file write) + a full turn in the cockpit UI, all on a local QVAC model |

Both harnesses are now driven end to end. For OpenClaw the ACP mission-control bridge is a thin
proxy to the OpenClaw **Gateway**, so it needs (1) `openclaw gateway` running and (2) this device
paired with `operator.admin` scope (one-time `openclaw devices approve` / `openclaw onboard`), else
it exits with `scope upgrade pending approval`. The cockpit surfaces that as an actionable hint
(`AcpClient.hintFor`) and onboarding reports `gatewayUp`; it is OpenClaw's own device-pairing
security boundary, not a cockpit bug. OpenClaw's tool permissions are config-driven (`tools.allow`),
so it only emits an ACP permission request (the "Needs You" queue) when a tool is not pre-authorized.

Per-harness capability badges in the header show, honestly, what the connected harness exposes
(session replay / plan / permission gating over ACP, plus which store panes it backs). Panes a
harness does not have report "not available for this harness" rather than an error.

Pi (pi.dev) is intentionally out of scope: no ACP bridge or native structured-event stream is
verified against a real local binary, so there is nothing yet for the cockpit to front-end.

## Run (dev)
```
git clone https://github.com/thomasblc/qvac-agent-cockpit.git
cd qvac-agent-cockpit
npm install --no-workspaces
npm run preflight                      # checks Node >=22.5 (node:sqlite), qvac on PATH, a harness home dir
node server/server.js                  # http://localhost:8150 ; supervises qvac serve on :11434
```
Requires Node **>=22.5** (`.nvmrc` pins 24; `node:sqlite` is unavailable on Node 20) and a harness
installed (default `~/.hermes`; set `COCKPIT_HARNESS=openclaw` + `COCKPIT_WORKSPACE=...` for
OpenClaw). QVAC CLI on PATH. macOS / Apple Silicon.

For OpenClaw's model connection: `npm install -g openclaw @qvac/openclaw-plugin @qvac/cli @qvac/sdk`,
then `openclaw plugins install @qvac/openclaw-plugin && openclaw plugins enable qvac` (see
`@qvac/openclaw-plugin` README for the full onboarding flow).

### Gates
```
node _verify_links.mjs                 # 7 pure regression tests, no live server needed
npm run audit:gates                    # 20 mocked/pure security + scale tests (jail, permissions, egress display, semantic-scale), no live agent turns
node server/server.js &                # then, against the live server:
node _verify_p1.mjs   # ... through _verify_p6.mjs
```
`_verify_p1..p6` send real agent turns and write into `workspace/`; run them
one at a time (a live turn can take 20-30s, batching several in one shell command can hit the
harness's own timeout). `npm run audit:gates` is pure/mocked and safe to run anytime, including in CI.

## Security invariants (do not regress; see `_verify_security.mjs`)
- File jail (`server/safe-path.js`): rejects symlinks, hardlinks (`nlink > 1`), and any path whose
  realpath resolves outside the corpus roots, re-checked immediately before every write (TOCTOU-safe).
- Permission fallback (`acp-client.js`): a human-gate timeout or an allow-only option set NEVER
  auto-allows; it picks an explicit reject option or answers the protocol-level `cancelled` outcome.
- Egress display (`public/egress-format.js`): never renders a "0 bytes" sovereignty claim before a
  real measured sample; "unmonitored" and "measuring" are distinct, honest states.
- Onboarding (`server/onboard.js`): redacts any config key matching `/key|token|secret|password|...|private/i`;
  never reads `~/.hermes/auth.json` or `.env`.

## Status
V1 complete (all six panes built and gated) + a full external-audit fix-pack applied (4 P0 + 8 P1
findings, all fixed and re-gated, including the UI capability badges). OpenClaw is now a first-class
second harness: model connection via the native `@qvac/openclaw-plugin` (SDK 0.15), mission-control
ACP driven end to end, and History + Skills store panes wired through the OpenClaw CLI. Pi dropped
from scope. See `CHANGELOG.md`.
