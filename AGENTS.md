# Repository Guidelines

This playbook supports contributors building the AI-driven trading agent that powers `open-nof1.ai`. Adhere to the practices below to keep code, automation, and trading behaviour coherent across the team.

## Project Structure & Module Organization
- `src/index.ts` boots the VoltAgent workflow; agents live in `src/agents/`, API routes in `src/api/`, and cross-cutting utilities in `src/utils/`.
- Scheduling (`src/scheduler/`) and services (`src/services/`) orchestrate trading loops, while `src/database/` manages LibSQL access and migrations.
- Configuration is layered under `src/config/`; reusable CLI and maintenance helpers sit in `scripts/`.
- Strategy templates and documentation live in `strategies/`, and the dashboard assets reside in `public/`.
- Exchange adapters reside in `src/services/exchanges/` (`gateExchangeClient.ts`, `binanceExchangeClient.ts`, and the `index.ts` factory). Reuse the factory instead of instantiating exchange SDKs directly.

## Build, Test, and Development Commands
- `npm run setup` installs deps and scaffolds local folders; re-run after pulling infra changes.
- `npm run dev` starts the hot-reload TSX watcher with `.env` applied; use for agent iteration.
- `npm run build` compiles using `tsdown`; `npm run start` serves the built bundle from `dist/`.
- `npm run lint`, `npm run lint:fix`, and `npm run typecheck` enforce Biome and TypeScript gates before review.
- Database lifecycle helpers: `npm run db:init`, `npm run db:reset`, and `npm run db:sync` (mirrors whichever exchange `EXCHANGE_PROVIDER` selects). Trading control scripts include `npm run trading:start|stop|restart`.

## Coding Style & Naming Conventions
- TypeScript, ES modules, Node.js ≥20.19.0, strict compiler flags enabled. Use 2-space indentation and trailing commas per Biome defaults.
- Name files and modules with kebab-case (`trading-loop.ts`), export classes with PascalCase, and functions/instances with camelCase.
- Keep environment-specific constants in `src/config/` and guard direct `.env` access to boot-time code.
- Binance dry-run mode mirrors freqtrade’s `dry-run`: set `EXCHANGE_DRY_RUN=true` (Binance only) to consume live quotes while executing orders against the in-process simulator (`src/services/exchanges/dryRunExchangeClient.ts`). Dry-run 会自动把钱包余额、持仓、订单和成交记录持久化到 `.voltagent/dry-run-state.json`（可用 `DRY_RUN_STATE_PATH` 自定义路径，或用 `DRY_RUN_RESET=true` 清空）。Document expected behaviour in PRs when toggling this flag.
- 裸K Agent：通过 `AI_AGENT_PROFILE=naked-k` 切换至裸K 决策模式，系统会按 `NAKED_K_PROFILE`（baseline/scalper/swing）缓存多时间框架的 OHLCV 数据，并在每轮只增量刷新。默认缓存位置 `.voltagent/kline-cache/`。
- 系统风控（止盈/移动止盈/止损）：通过 `SYSTEM_PROTECTION_ENABLED=true` 打开独立风控，每 `SYSTEM_PROTECTION_INTERVAL_SECONDS` 秒巡检一次。配置项：
  - `SYSTEM_TAKE_PROFIT_ENABLED` + `SYSTEM_TAKE_PROFIT_PERCENT` / `SYSTEM_TAKE_PROFIT_CLOSE_PERCENT` / `SYSTEM_TAKE_PROFIT_MAX_TRIGGERS`
  - `SYSTEM_STOP_LOSS_ENABLED` + `SYSTEM_STOP_LOSS_PERCENT` / `SYSTEM_STOP_LOSS_CLOSE_PERCENT`
  - `SYSTEM_TRAILING_ENABLED` + `SYSTEM_TRAILING_TIERS`（如 `5:2:25,10:5:50,15:12:100`，表示利润达 5% 时锁在 2%、平 25%，达 10% 时锁 5%、平 50%，达 15% 时直接全平）
  - 系统触发的平仓会记入 `trades` 表，并在提示词的“最近交易”段出现，AI 能感知系统已锁定利润。
- Telegram notifications are optional: set `TELEGRAM_BOT_TOKEN` to enable the bot (`src/services/telegramBot.ts`). Keep notifier calls (`src/services/notifier.ts`) side-effect free so missing credentials never break trade execution.

## Configuration Notes
- Toggle exchanges via `EXCHANGE_PROVIDER` in `.env` (`gate` or `binance`); surface-specific credentials (`GATE_API_*` or `BINANCE_API_*`) must be present for the selected provider.
- Prefer reading exchange selection with `getActiveExchangeId()` to keep feature flags and logs consistent.

## Testing Guidelines
- Automated tests are not yet formalised; favour behaviour scripts under `scripts/` executed via `npx tsx` (e.g., `npm run demo:calculate-pnl`) to capture regression coverage.
- New suites should adopt `*.spec.ts` co-located near the feature or inside `tests/` if you introduce one; wire them into `package.json` as `npm run test`.
- Document verification steps in PRs whenever the agent touches live trading logic or schema migrations.

## Commit & Pull Request Guidelines
- Follow Conventional Commits (`feat:`, `fix:`, `refactor:`) as seen in history (`refactor: 优化日志记录...`).
- Keep commits scoped and translation-ready; prefer English summaries with clarifying Mandarin comments if required.
- Pull requests must: link issues, outline risk/roll-back, list affected commands or env vars, and attach screenshots/log excerpts for UI or strategy changes.
