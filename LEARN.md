# Learning hcai-cli: CLI Design for Humans & AI Agents

This guide explains the architectural decisions behind designing command-line tools for autonomous coding agents as well as humans.

---

## 1. The Dual-Audience CLI Pattern

Most developer CLIs assume an interactive human at a TTY terminal with colored spinners, pagers, and interactive prompts. Coding agents (like Antigravity, Claude Code, Cursor) fail or hang on interactive prompts.

`hcai-cli` implements key patterns for dual-audience operation:
1. **Machine-Readable Flag (`--output json`):** Every command can return structured JSON for easy piping to `jq` or programmatic consumption.
2. **Deterministic Non-Interactive Execution:** Zero interactive prompts required. If a parameter is missing, clear error output and exit codes are returned.
3. **Flexible Input Channels:** Accepts parameters via flags, stdin streams (`cat prompt.txt | hcai chat -m ...`), or environment variables.

---

## 2. API Proxy Integration

- **Hack Club AI Endpoints:** Routes chat completions through Hack Club's OpenAI-compatible gateways.
- **Dynamic Allowlist Discovery:** Fetches active models and authorized Replicate models directly from Hack Club's open-source manifests, caching with a local fallback bundle.
- **Modular Subcommands:** `auth`, `models`, `chat`, `tts`, `replicate`, `embed`.
