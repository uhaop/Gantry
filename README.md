<div align="center">

# Gantry

**Your AI IDE is trapped on your desktop. Gantry breaks it free.**

Control Cursor, Windsurf, and VS Code from your phone, your team's Discord, email, or any HTTP client.
Open-source headless IDE bridge with self-healing diagnostics.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## Release Channel

- Current channel: **`v0.x` preview** (`0.1.0`)
- Stability target: production-minded local usage with best-effort IDE automation and evolving adapter coverage
- Semver policy: breaking changes may occur until `v1.0.0`

---

## Why Gantry?

- **Work from anywhere** — Send prompts to Cursor, Windsurf, or VS Code from Telegram on your phone, Discord on your tablet, or a cURL script in CI. No VNC, no RDP, no screen sharing.
- **Multi-IDE, multi-platform** — One bridge per IDE. Run multiple IDE instances in parallel with independent Telegram bots. Add Discord, Feishu, Email, or HTTP API adapters in parallel.
- **Self-healing diagnostics** — When an IDE update breaks a CSS selector, Gantry detects it on startup, auto-discovers replacement candidates from the live DOM, and sends you actionable fix instructions via Telegram.
- **Security-first, audit the code** — Prompt exfiltration is blocked at the input layer. Outbound responses are sanitized to redact tokens, keys, and secrets. The entire guardrail system is open source — read every line.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                  Platform Adapters                        │
│  Telegram (primary) · Discord · HTTP API · Feishu · Email │
└──────────────────────────┬────────────────────────────────┘
                           │
                    ┌──────▼────────┐
                    │ CommandRouter │  ← Parses commands, manages state
                    └──────┬────────┘
                           │
                    ┌──────▼────────┐
                    │ BridgeService │  ← Orchestrates IDE operations
                    └──────┬────────┘
                           │
               ┌───────────┬────────────┐
               │           │            │
        ┌──────▼──────┐    │     ┌──────▼───────┐
        │ CDP Backend │    │     │  API Backend │
        │  (default)  │    │     │ (Cursor only)│
        └──────┬──────┘    │     └──────┬───────┘
               │           │            │
      ┌────────▼───────────▼─────────┐  │
      │ Cursor/Windsurf/VS Code CDP  │  │
      │          clients             │  │
      └────────┬──────────┬──────────┘  │
               │          │             │
          Cursor IDE   Windsurf IDE  Cursor API
          (CDP :9222)  (CDP :9223)   backend
                        VS Code IDE
                        (CDP :9224)
```

Gantry connects to your IDE via **Chrome DevTools Protocol** (the same protocol used by Chrome DevTools). Cursor, Windsurf, and VS Code can be launched with `--remote-debugging-port` so Gantry can automate the chat panel on a best-effort basis.

---

## Features

> **Preview release (`v0.x`)**
> - Currently Telegram is the most fleshed-out platform with the most features implemented.
> - Must run IDEs with `--remote-debugging-port` flag to enable bridge connection.
> - Remote connection should still be your backup to review the IDE state, questions, plans not always detected.
> - Cursor selectors updated to target `.tiptap.ProseMirror` chat input and assistant markdown responses; adjust `.env` only if your build diverges.
> - Quick actions (/start) for Cursor & Windsurf: New chat | Last · Mode Ask | Mode Code · Mode Plan | Context % · Restart · Help.
> - VS Code `/model` and `/models` now use best-effort DOM detection/listing from visible model controls; results depend on your local VS Code chat UI state.
> - `/restart` added (quick action + command) to relaunch the bridge; users get a "Bridge restarted and is now online." notice after it comes back.
> - Context output is minimal: `Context status` / `• Context 20%` (no paths or notes).
> - Support labels follow the integration contract: `official`, `best-effort`, `unsupported-contract`.


### IDE Control
| Feature | Cursor | Windsurf | VS Code |
|---|---|---|---|
| Prompt relay + response capture | best-effort | best-effort | best-effort |
| Mode switching | official (`ask/code/plan/debug`) | official (`ask/code/plan`, `debug` unavailable) | best-effort (`ask/code/plan`, `debug` unavailable) |
| Model detection + switching | best-effort | best-effort | best-effort (DOM-driven detect/list/switch with explicit unverified/failure states) |
| New chat / session management | official + best-effort | official + best-effort | best-effort (explicit unverified/failure states) |
| Photo & document attachment | official + best-effort | official + best-effort | official + best-effort |
| Target/tab selection | best-effort | best-effort | best-effort |
| Context usage extraction | best-effort | best-effort | best-effort |
| API backend (no CDP needed) | official (Cursor-only path) | unavailable | unavailable |

### Platform Adapters
| Adapter | Capabilities |
|---|---|
| **Telegram (primary)** | Full command surface, inline buttons/quick actions, photo/document attach, restart notice, auto question alerts (not always reliable) |
| **Discord** | Text commands only via replies (no buttons, no restart notice, limited attachments) |
| **HTTP API** | OpenAI-compatible `POST /v1/chat/completions` endpoint (best-effort) |
| **Feishu / Lark** | Text commands only (no buttons/attachments) |
| **Email** | Text commands only via first line of the email body (no buttons/attachments) |

### Self-Healing & Diagnostics
| Feature | Description |
|---|---|
| CDP preflight check | Validates connectivity + selector health on every startup (Flags issues at times even though everything working as intended.)|
| Auto-discovery | Scans live DOM for replacement selector candidates with confidence scores |
| Startup alerts | Sends actionable Telegram notifications with IDE version, cause, and fix |
| `/diag` command | On-demand full diagnostic with selector match counts and candidates |
| Non-blocking | Bridge always starts — preflight issues are warnings, never blockers |

### Security Guardrails
| Layer | Protection |
|---|---|
| **Inbound** | Blocks prompt exfiltration attempts (cookies, tokens, env dumps, secrets) |
| **Outbound** | Redacts API keys, bearer tokens, cookie values, and assignment-style secrets |
| **Access** | Per-platform user allowlists (Telegram IDs, Discord IDs, email senders, Feishu open IDs) |
| **Network** | Local-only execution — no cloud, no telemetry, no phone-home |

---

## Quick Start

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token.

### 2. Configure

```bash
cp .env.example .env
```

Set these three values in `.env`:

```env
TELEGRAM_BOT_TOKEN=your-bot-token
BRIDGE_IDE_TARGET=cursor          # "cursor", "windsurf", or "vscode"
TELEGRAM_ALLOWED_USER_IDS=12345   # your Telegram user ID
```

### 3. Launch your IDE with remote debugging
You may not always see existing conversations in the active IDE chat window, but bridge interaction still works for new prompts and follow-ups.
```powershell
# Cursor
"%LOCALAPPDATA%\Program Files\Cursor\Cursor.exe" --remote-debugging-port=9222

# Windsurf
"%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe" --remote-debugging-port=9223

# VS Code
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" --remote-debugging-port=9224
```

### 4. Start Gantry

```bash
npm install
npm run dev
```

Open your Telegram bot and send `/help`. You're live.

Health check: [http://localhost:8787/health](http://localhost:8787/health)

---

## Commands

### Core

| Command | Description | Example |
|---|---|---|
| `/newchat` | Start a fresh IDE chat session | `/newchat` |
| `/mode <mode>` | Switch mode: `ask`, `code`, `plan`, `debug` | `/mode code` |
| `/model [name]` | Detect current model or best-effort switch by fuzzy match (`/model` reads current label) | `/model claude sonnet` |
| `/last` | Get latest assistant response | `/last` |
| `/resume [text]` | Continue previous task | `/resume fix the tests` |
| `/choose <option>` | Answer assistant question | `/choose A` |
| `/diag` | Full CDP + selector diagnostics | `/diag` |
| `/restart` | Restart bridge (uses platform-specific launcher) | `/restart` |

### Status & Session

| Command | Description |
|---|---|
| `/context` | Context window usage |
| `/usage` | Usage/billing status |
| `/progress` | Active request state + elapsed time |
| `/targets` or `/chats` | List available IDE targets |
| `/target <n>` or `/target auto` | Select specific target or auto-select |
| `/history [n\|clear]` | Recent responses or clear history |
| `/cancel [all]` | Stop follow-up polling |

### Attachments (Telegram)

| Command | Description |
|---|---|
| Send photo | Attaches image to IDE composer (send images before prompting)|
| Send document | Attaches file to IDE composer (send files before prompting)|
| `/attach <path>` | Inject local file by absolute path |
| `/attach <path> | prompt` | Attach + auto-submit with prompt |
| `/photomode auto|manual` | Toggle auto-submit for attachments |
| `/queue` | View pending attachment queue |
| `/clearqueue` | Clear attachment queue |

> **Tip:** When sending photos, send the image first, then type your prompt after the image is delivered. For files it works the same way.

### Choose (Question Routing)

When the assistant asks a question, Gantry sends an automatic alert with quick-reply options (not always reliable - false flags possible, use remote desktop connection to verify):

```
/choose A                         # Select option A
/choose D your custom answer      # Custom response
/choose multi A,C                 # Multiple options
/choose multi A,C,D:custom text   # Multiple + custom
```

---

## Supported IDEs

### Latest Verification Snapshot (local)

- Cursor preflight: PASS (latest local run)
- Windsurf preflight: PASS (latest local run)
- VS Code preflight: PASS (latest local run)
- Command: `npx tsx scripts/cdp-preflight.ts` with `BRIDGE_IDE_TARGET` set per IDE

### Mode Mapping

| Gantry Mode | Cursor | Windsurf | VS Code |
|---|---|---|---|
| `ask` | official (`Ask`) | official (`Chat`) | best-effort (`Ask`) |
| `code` | official (`Agent`) | official (`Write`) | best-effort (`Agent`) |
| `plan` | official (`Plan`) | official (`Plan`) | best-effort (`Plan`) |
| `debug` | official (`Debug`) | unavailable | unavailable |

### Model Switching

- **Cursor (`best-effort`)**: CSS selector-based dropdown detection (`[class*="composer-unified-dropdown-model"]` + fallbacks)
- **Windsurf (`best-effort`)**: Keyword-based button scanning near Cascade panel elements
- **VS Code (`best-effort`)**: reads current model label, opens picker, lists visible options, and selects best fuzzy match when possible
- Fuzzy matching: exact > contains > partial word match
- Example: `/model claude sonnet`, `/model gpt-4o`, `/model auto`
- If target model is not visible in the current picker state, bridge returns explicit `model-not-found`/`unverified` instead of false success.

---

## Self-Healing Alerts

When an IDE update changes the DOM structure, Gantry catches it immediately:
(Alerts sometimes are false flags just send slash commands to verify)
```
⚠️ Bridge Alert (Cursor v0.48.7): Selector CHAT_INPUT failed (no matches).
Likely Cause: Cursor v0.48.7 update changed the Composer layout.
Auto-Discovered: "div[role="textbox"]" (class="new-composer-input", score=350)
Quick Fix: Update CURSOR_CHAT_INPUT_SELECTOR in .env, or run /diag to see all candidates.

Run /diag anytime for a full diagnostic with auto-discovered selector candidates.
```

**Alert types:**
- **CDP unreachable** — launch command + port-conflict hint
- **No page targets** — "open a folder + panel" guidance
- **Selector broken** — IDE version, auto-discovered best candidate with class/score, exact `.env` var name
- **Invalid CSS** — syntax error hint
- **Mode indicator missing** — panel-collapsed warning

---

## HTTP Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Bridge health + backend mode |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completion |
| `POST` | `/platform/feishu/events` | Feishu/Lark event intake |

The HTTP API accepts standard OpenAI chat payload and returns a compatible completion response. Optional auth via `BRIDGE_API_AUTH_TOKEN` bearer token.

---

## Advanced Setup

### Multi-IDE (Parallel Instances)

Run two bridge instances with separate configs and Telegram bots:

```powershell
# Terminal 1 — Cursor
$env:DOTENV_CONFIG_PATH=".env.cursor"; npx tsx src/index.ts

# Terminal 2 — Windsurf
$env:DOTENV_CONFIG_PATH=".env.windsurf"; npx tsx src/index.ts
```

Each instance needs its own `TELEGRAM_BOT_TOKEN`, `PORT`, and `BRIDGE_IDE_TARGET`. Create separate bots via @BotFather.

### CDP vs API Backend

| | CDP (default) | API |
|---|---|---|
| Requires IDE with `--remote-debugging-port` | ✅ | — |
| Requires API credentials | — | ✅ (Cursor only) |
| Mode/model switching | ✅ | — |
| Photo/document attach | ✅ | — |
| Target selection | ✅ | — |
| Prompt relay | ✅ | ✅ |

Set `BRIDGE_BACKEND_MODE=api` in `.env` for API mode (Cursor only).

---

<details>
<summary><strong>Configuration Reference</strong></summary>

### Required

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather |

### General

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Runtime environment |
| `LOG_LEVEL` | `info` | Pino log level |
| `PORT` | `8787` | HTTP server port |
| `BRIDGE_IDE_TARGET` | `cursor` | `cursor`, `windsurf`, or `vscode` |
| `BRIDGE_BACKEND_MODE` | `cdp` | `cdp` or `api` |
| `BRIDGE_API_AUTH_TOKEN` | — | Optional bearer token for HTTP API |
| `TELEGRAM_ALLOWED_USER_IDS` | — | Comma-separated allowlist |
| `TELEGRAM_REQUEST_TIMEOUT_MS` | `30000` | Relay timeout |

### Cursor

| Variable | Default | Description |
|---|---|---|
| `CURSOR_REMOTE_DEBUG_URL` | `http://127.0.0.1:9222` | CDP endpoint |
| `CURSOR_TARGET_TITLE_HINT` | `Cursor` | Window title filter |
| `CURSOR_CHAT_INPUT_SELECTOR` | (built-in) | Chat input CSS selector override |
| `CURSOR_RESPONSE_SELECTOR` | (built-in) | Response container CSS selector override |
| `CURSOR_CONTEXT_SELECTOR` | (built-in) | Context indicator CSS selector override |
| `CURSOR_MODEL_SELECTOR` | `[class*="composer-unified-dropdown-model"]` | Model dropdown CSS selector |
| `CURSOR_ACTION_TIMEOUT_MS` | `30000` | Action timeout |
| `CURSOR_SQLITE_PATH` | (auto-detected) | State database path |
| `CURSOR_APP_EXE` | `Cursor` | Executable hint |
| `CURSOR_CONTEXT_REGION` | — | OCR crop region: `x,y,width,height` |
| `CURSOR_CONTEXT_HOVER_POINT` | — | Hover point: `x,y` |

### Windsurf

| Variable | Default | Description |
|---|---|---|
| `WINDSURF_REMOTE_DEBUG_URL` | `http://127.0.0.1:9223` | CDP endpoint |
| `WINDSURF_TARGET_TITLE_HINT` | `Windsurf` | Window title filter |
| `WINDSURF_CHAT_INPUT_SELECTOR` | (built-in) | Chat input CSS selector override |
| `WINDSURF_RESPONSE_SELECTOR` | (built-in) | Response container CSS selector override |
| `WINDSURF_MODE_SELECTOR` | (built-in) | Mode switcher CSS selector override |
| `WINDSURF_CONTEXT_SELECTOR` | (built-in) | Context indicator CSS selector override |
| `WINDSURF_MODEL_SELECTOR` | (auto-detect) | Model button keyword scan override |
| `WINDSURF_ACTION_TIMEOUT_MS` | `30000` | Action timeout |
| `WINDSURF_SQLITE_PATH` | (auto-detected) | State database path |

### VS Code

| Variable | Default | Description |
|---|---|---|
| `VSCODE_REMOTE_DEBUG_URL` | `http://127.0.0.1:9224` | CDP endpoint |
| `VSCODE_TARGET_TITLE_HINT` | `Code` | Window title filter |
| `VSCODE_CHAT_INPUT_SELECTOR` | (built-in) | Chat input CSS selector override |
| `VSCODE_RESPONSE_SELECTOR` | (built-in) | Response container CSS selector override |
| `VSCODE_MODE_SELECTOR` | — | Optional mode selector override |
| `VSCODE_MODEL_SELECTOR` | — | Optional model label/picker selector override |
| `VSCODE_CONTEXT_SELECTOR` | — | Optional context selector override |
| `VSCODE_ACTION_TIMEOUT_MS` | `30000` | Action timeout |
| `VSCODE_SQLITE_PATH` | (auto-detected) | State database path |

### Cursor API Backend

| Variable | Default | Description |
|---|---|---|
| `CURSOR_API_KEY` | — | API key (required for API mode) |
| `CURSOR_API_BASE_URL` | `https://api.cursor.com` | API base URL |
| `CURSOR_API_REPOSITORY` | — | Repository (required for API mode) |
| `CURSOR_API_MODEL` | — | Model override |
| `CURSOR_API_REF` | — | Git ref |
| `CURSOR_API_TIMEOUT_MS` | `30000` | API timeout |

### Discord

| Variable | Default | Description |
|---|---|---|
| `DISCORD_ENABLED` | `false` | Enable Discord adapter |
| `DISCORD_BOT_TOKEN` | — | Discord bot token |
| `DISCORD_ALLOWED_USER_IDS` | — | Comma-separated allowlist |

### Email

| Variable | Default | Description |
|---|---|---|
| `EMAIL_ENABLED` | `false` | Enable email adapter |
| `EMAIL_ALLOWED_FROM` | — | Sender allowlist (empty = allow all) |
| `EMAIL_IMAP_HOST` | — | IMAP server host |
| `EMAIL_IMAP_PORT` | — | IMAP port |
| `EMAIL_IMAP_SECURE` | — | IMAP TLS |
| `EMAIL_IMAP_USER` | — | IMAP username |
| `EMAIL_IMAP_PASS` | — | IMAP password |
| `EMAIL_SMTP_HOST` | — | SMTP server host |
| `EMAIL_SMTP_PORT` | — | SMTP port |
| `EMAIL_SMTP_SECURE` | — | SMTP TLS |
| `EMAIL_SMTP_USER` | — | SMTP username |
| `EMAIL_SMTP_PASS` | — | SMTP password |
| `EMAIL_POLL_INTERVAL_MS` | `30000` | IMAP poll interval |

### Feishu / Lark

| Variable | Default | Description |
|---|---|---|
| `FEISHU_ENABLED` | `false` | Enable Feishu adapter |
| `FEISHU_APP_ID` | — | App ID |
| `FEISHU_APP_SECRET` | — | App secret |
| `FEISHU_VERIFICATION_TOKEN` | — | Event verification token |
| `FEISHU_ENCRYPT_KEY` | — | Signature verification key |
| `FEISHU_ALLOWED_OPEN_IDS` | — | Comma-separated allowlist |

</details>

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Run from source with hot-reload (`tsx`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run compiled output |
| `npm run lint` | ESLint check |
| `npm run typecheck` | TypeScript type check (no emit) |
| `npm run verify` | Lint + typecheck + build |
| `npm run test:smoke` | Fast smoke checks for core guardrails + local state persistence |
| `npm run scan:secrets` | Scan tracked files for high-risk secret/PII patterns |
| `npm run verify:release` | Release gate: verify + smoke + secret scan |

**Diagnostics:**
- `npx tsx scripts/cdp-preflight.ts` — CDP connectivity + selector health check
- `npm run scan:secrets` — Fail if tracked files contain token/key/PII signatures

---

## Gantry Enterprise

Gantry Core is **free and open source** under the AGPL-3.0 license for local, single-workstation use. The full source is here — audit every line of the security guardrails, selector health system, and CDP automation logic.

For teams and organizations that need more, **Gantry Enterprise** extends the core with:

- **Multi-Axis Control** — Manage 3+ IDE instances across multiple machines or remote VPS from a single control plane
- **Cloud Dashboard** — Web-based monitoring for multiple workstations, team activity, and bridge health
- **Priority Selector Updates** — When IDE updates break selectors, Enterprise subscribers receive verified `.env` selector configs automatically — no manual `/diag` debugging required
- **Priority Support** — Direct engineering support channel for integration and deployment

[Join the waitlist →](https://store.graspvisual.com/gantry)

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

You are free to use, modify, and distribute Gantry. If you modify Gantry and offer it as a network service, you must make your modified source available under the same license.

---

<div align="center">

**Built by [Grasp Visual](https://graspvisual.com)**

</div>
