# Contributing to Gantry

Thanks for your interest in contributing to Gantry. This document covers the basics.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `npm install`
4. Copy `.env.example` to `.env` and configure for your IDE
5. Run in dev mode: `npm run dev`

## Development Workflow

```bash
# Run from source
npm run dev

# Lint
npm run lint

# Type check
npm run typecheck

# Full verify (lint + typecheck + build)
npm run verify
```

## Before Submitting a PR

1. **Run `npm run verify`** — all three checks (lint, typecheck, build) must pass with zero errors.
2. **Test your changes** — if you modified command routing, verify the affected `/command` works end-to-end with a live IDE.
3. **Run the preflight check** — `npx tsx scripts/cdp-preflight.ts` should still pass if you touched CDP or selector logic.
4. **Keep commits focused** — one logical change per commit.

## Code Style

- TypeScript strict mode
- ESLint enforced (see `eslint.config.mjs`)
- No unused variables or imports
- Prefer explicit error handling over silent catches
- Follow existing patterns in adjacent files

## Architecture Notes

- **Platform adapters** (`src/platform/`, `src/telegram/`) handle inbound messages and route them through `CommandRouter`
- **BridgeService** (`src/bridge/`) orchestrates IDE operations — don't put platform-specific logic here
- **CDP clients** (`src/cdp/`, `src/cursor/`, `src/windsurf/`) handle IDE-specific automation
- **Security** (`src/security/`) — inbound prompt filtering and outbound secret redaction

## Adding a New Platform Adapter

1. Create `src/platform/YourService.ts`
2. Wire it into `src/index.ts` (follow the Discord/Email pattern)
3. Route commands through the shared `CommandRouter`
4. Add env vars to `src/config.ts` (zod schema) and `.env.example`
5. Update the README Platform Adapters table

## Adding a New Command

1. Add the handler to `BridgeService` if it requires IDE interaction
2. Add routing in `CommandRouter.handle()`
3. Add Telegram-specific handling in `TelegramBotService` if needed
4. Update the README Commands table

## Selector Changes

If an IDE update breaks selectors:

1. Run `npx tsx scripts/cdp-preflight.ts` to discover new candidates
2. Update the built-in selector in the relevant automation client
3. Test with `/diag` to confirm match counts are non-zero
4. Document the IDE version that triggered the change

## Reporting Issues

- Include your IDE name and version (visible in `/diag` output)
- Include the output of `/diag` if it's a selector or CDP issue
- Include relevant bridge log output (set `LOG_LEVEL=debug` for verbose logs)

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 license.
