# Deployment Runbook

## Purpose
This runbook explains how to boot `meridian_v2` in supervised runtime mode using the built-in `runLive.ts` entrypoint.

This repo is ready for supervised live operation, but the current bootstrap still has a few intentional constraints:
- wallet balance is currently sourced from `MOCK_WALLET_BALANCE_SOL`
- SOL/USD pricing is currently sourced from `MOCK_SOL_PRICE_USD`
- `runLive.ts` wires a conservative `signalProvider`
- `rebalancePlanner` is currently `null`

Because of those constraints, this runbook is best used for:
- first supervised boot
- dry-run runtime validation
- small-capital supervised trials
- live lifecycle verification with strong operator oversight

## Prerequisites
- Node.js `>=18`
- npm installed
- valid `.env`
- valid `user-config.json`
- one dedicated process only for a given `MERIDIAN_DATA_DIR`

Do not run two runtime supervisors against the same data directory.

## Required Files
- [.env](../.env)
- [user-config.json](../user-config.json)

Template references:
- [.env.example](../.env.example)
- [user-config.example.json](../user-config.example.json)

## Minimum Environment
Required in `.env`:

```dotenv
WALLET_PRIVATE_KEY=...
RPC_URL=https://...
PUBLIC_WALLET_ADDRESS=...
DLMM_API_BASE_URL=https://...
```

Recommended for runtime clarity:

```dotenv
MERIDIAN_DATA_DIR=/absolute/path/to/runtime-data
MOCK_SOL_PRICE_USD=150
MOCK_WALLET_BALANCE_SOL=1
ACTION_QUEUE_INTERVAL_SEC=5
DLMM_TIMEOUT_MS=15000
```

Optional integrations:

```dotenv
SCREENING_API_BASE_URL=https://...
ANALYTICS_API_BASE_URL=https://...
JUPITER_QUOTE_BASE_URL=https://...
JUPITER_EXECUTE_BASE_URL=https://...
LLM_BASE_URL=https://...
LLM_API_KEY=...
SCREENING_API_KEY=...
ANALYTICS_API_KEY=...
JUPITER_API_KEY=...
TELEGRAM_BOT_TOKEN=...
```

Telegram delivery becomes active only when all three are true:
- `notifications.telegramEnabled = true`
- `notifications.alertChatId` is set in `user-config.json`
- `TELEGRAM_BOT_TOKEN` is set in `.env`

## Recommended First Config
For first supervised deployment, keep:
- `runtime.dryRun = true`
- `ai.mode = "disabled"` or `"advisory"`
- `notifications.telegramEnabled = false`
- `claim.autoSwapAfterClaim = false`
- `claim.autoCompoundFees = false`
- `management.trailingTakeProfitEnabled = false` unless you specifically want to test it

Suggested first-pass runtime behavior:
- deploys blocked manually until health checks are clean
- no auto-compounding
- no AI-driven changes beyond advisory

## Boot Commands
Install dependencies if needed:

```bash
npm install
```

Build once:

```bash
npm run build
```

Run live supervisor:

```bash
npm run live
```

This command:
- builds the project
- boots `dist/runtime/runLive.js`
- runs startup recovery
- runs one startup cycle:
  - screening
  - reconciliation
  - management
  - queue
  - reporting
- then starts periodic timers

## What To Expect At Boot
On successful boot, logs should show:
- runtime bootstrap configuration loaded
- startup recovery completed
- startup cycle completed
- runtime supervisor is running

Expected warnings that are currently non-fatal:
- `telegramEnabled=true but Telegram notifier is not fully configured`
- `AI mode is enabled but live LlmGateway is not fully configured`

Those warnings are intentional signals about incomplete runtime wiring, not immediate boot failures.

## Runtime Data Directory
The runtime persists state under `MERIDIAN_DATA_DIR`, or the default resolved data dir if unset.

Key files include:
- `positions.json`
- `actions.json`
- `journal.jsonl`
- `lessons.json`
- `pool-memory.json`
- `policy-overrides.json`
- `signal-weights.json`
- `scheduler-metadata.json`
- `runtime-control.json`

Before first live boot:
- ensure the directory is writable
- ensure only one supervisor process will use it

## Health Validation
Immediately after boot, validate:
- no startup checklist item is `ok: false`
- `scheduler-metadata.json` is being updated
- `journal.jsonl` is appendable
- no repeated crash loop in logs
- action queue tick is running

If startup status is `UNSAFE`, stop and inspect before continuing.

## Safe First Activation Path
Use this progression:

1. `runtime.dryRun = true`
2. confirm startup recovery is `HEALTHY`
3. confirm screening/reconciliation/management/reporting ticks complete
4. confirm state files are stable
5. enable small-capital supervised live mode by setting `runtime.dryRun = false`
6. keep AI either `disabled` or `advisory`
7. keep auto-compound disabled initially

## Suggested Process Management
Any single-process supervisor is acceptable:
- `pm2`
- `systemd`
- `supervisord`

Requirements:
- automatic restart on crash
- one instance only
- stdout/stderr log capture
- environment file support

Example `pm2` command:

```bash
pm2 start npm --name meridian-v2 -- run live
```

## Stop Procedure
Send `SIGINT` or `SIGTERM`.

`runLive.ts` already:
- clears queue/reconciliation/management/reporting timers
- clears the screening timeout
- logs shutdown signal

Avoid hard kill unless the process is wedged.

## Known Runtime Constraints
Current `runLive.ts` constraints:
- static env bridge for wallet balance
- static env bridge for SOL/USD price
- rebalance planner not wired
- signal provider is conservative

This means the runtime is suited for supervised operation, but not yet full unattended production autonomy.

## When To Abort Launch
Do not proceed to live mode if:
- startup recovery returns `UNSAFE`
- data directory is shared by another process
- DLMM base URL is unknown or untrusted
- you have no alert/log monitoring during first run
- `PUBLIC_WALLET_ADDRESS` does not match intended operator wallet

## Immediate Next Step
After using this runbook, execute the supervised live checklist:
- [SUPERVISED_LIVE_CHECKLIST.md](./SUPERVISED_LIVE_CHECKLIST.md)
