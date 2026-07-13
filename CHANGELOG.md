# Changelog

## 1.0.0 (2026-07-13)
- Initial public release: six panes (Cockpit, Mission Control, Second Brain, Files, Schedule, Skills), ACP client for Hermes/OpenClaw, supervised `qvac serve openai`, gamified voice-native HUD.
- OpenClaw model connection moved to the native `@qvac/openclaw-plugin` (QVAC SDK 0.15+), replacing the hand-wired OpenAI-endpoint base_url. Verified end-to-end (`openclaw agent --local` smoke test, `finalAssistantVisibleText: "pong"`, `provider: "qvac"`, `fallbackUsed: false`).
- Pi (pi.dev) dropped from scope: no verified ACP bridge or structured-event stream against a real local binary.
- Full external-audit fix-pack applied (file jail, permission fallback, egress display honesty, onboarding secret redaction). See `README.md` for the security invariants and gates.
