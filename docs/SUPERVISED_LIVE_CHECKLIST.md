# Supervised Live Checklist

## Goal
Use this checklist before and during the first 24-48 hour supervised live run.

This checklist assumes:
- [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) has already been followed
- runtime is single-instance
- operator is actively monitoring logs and state

## Phase 1: Pre-Flight
- Confirm `.env` is present and complete.
- Confirm `user-config.json` parses cleanly.
- Confirm `PUBLIC_WALLET_ADDRESS` is correct.
- Confirm `MERIDIAN_DATA_DIR` points to the intended runtime directory.
- Confirm only one process will use that data dir.
- Confirm `runtime.dryRun = true` for the first supervised boot.
- Decide whether `runtime.operatorStdinEnabled` should stay on for this run.
- If `notifications.telegramEnabled = true`, confirm both `TELEGRAM_BOT_TOKEN` and `notifications.alertChatId` are set.
- If `notifications.telegramOperatorCommandsEnabled = true`, confirm `notifications.telegramEnabled = true` and the configured `alertChatId` is the only Telegram chat authorized to issue commands.
- If you do not want Telegram delivery yet, keep `notifications.telegramEnabled = false`.
- Confirm `claim.autoSwapAfterClaim = false`.
- Confirm `claim.autoCompoundFees = false`.
- Confirm `management.trailingTakeProfitEnabled = false` unless you intentionally want to validate trailing in production.
- Confirm `ai.mode` is either `disabled` or `advisory`.

## Phase 2: First Boot
- Run `npm run live`.
- Wait for log line `startup recovery completed`.
- Verify startup status is `HEALTHY`.
- Wait for log line `startup cycle completed`.
- Wait for log line `runtime supervisor is running`.

Abort if:
- startup status is `UNSAFE`
- bootstrap crashes repeatedly
- state files cannot be written

## Phase 3: File-Level Sanity Check
Inspect runtime files:
- `positions.json`
- `actions.json`
- `journal.jsonl`
- `scheduler-metadata.json`
- `runtime-control.json`

Confirm:
- files exist
- file contents are valid JSON/JSONL
- timestamps are moving forward
- no unexpected `RUNNING` state remains stuck after clean startup

## Phase 4: Dry-Run Observation
Keep `runtime.dryRun = true` and observe at least one full cycle window.

Check:
- reconciliation tick runs
- management tick runs
- reporting tick runs
- screening tick runs if screening gateway is configured
- operator stdin commands respond if `runtime.operatorStdinEnabled = true`
- no uncontrolled queue growth
- no repeated `MANUAL_REVIEW_REQUIRED` from the same path without explanation

Expected acceptable warnings during this stage:
- AI fallback warnings in advisory paths
- Telegram configuration warning if Telegram is enabled but token or chat id is missing
- Telegram operator polling warning if inbound commands are enabled but token/chat-id wiring is incomplete

## Phase 5: Transition To Live
Only after dry-run observation is stable:
- set `runtime.dryRun = false`
- restart runtime cleanly
- keep position sizing conservative
- keep AI non-authoritative
- keep auto-compound off for the first live window

Recommended first-live settings:
- `ai.mode = "advisory"`
- `claim.autoSwapAfterClaim = false`
- `claim.autoCompoundFees = false`
- `management.trailingTakeProfitEnabled = false`

## Phase 6: First 24 Hours
During the first live window, monitor:
- new `QUEUED` actions
- `WAITING_CONFIRMATION` actions
- `TIMED_OUT` actions
- `RECONCILIATION_REQUIRED` positions
- startup recovery behavior on restart
- `journal.jsonl` event quality
- reporting summaries

Look specifically for:
- duplicate action creation
- actions that stop progressing
- positions flipped into reconciliation unexpectedly
- repeated scheduler skips with no completed runs

## Phase 7: Controlled Feature Activation
Enable advanced automation one step at a time.

Suggested order:
1. advisory AI
2. screening runtime
3. manual circuit breaker usage test
4. claim auto-swap
5. trailing take profit
6. claim auto-compound

Do not enable:
- trailing take profit
- auto-compound

at the same time as your first live activation unless you are intentionally testing them.

## Phase 8: Restart Drill
Perform one controlled restart while the bot is otherwise healthy.

Verify:
- process exits cleanly
- restart succeeds
- startup recovery completes
- scheduler state resumes
- no stale `RUNNING` deadlock remains
- no healthy position is downgraded incorrectly

## Phase 9: Panic Procedure
If market conditions look abnormal:
- trigger `circuit_breaker_trip`
- confirm no new deploy/rebalance requests proceed
- verify queue respects deploy-stop guard

When safe:
- trigger `circuit_breaker_clear`
- verify new deploys are allowed again

## Phase 10: Exit Criteria For “Stable Enough”
You can call the runtime stable enough for broader supervised use when:
- at least 24-48 hours pass without unexplained crash loops
- no unresolved stuck action remains
- no unexpected reconciliation escalations recur
- startup recovery behaves predictably
- manual circuit breaker works as expected
- reports and journal events are understandable

## Keep Deferred For Later
Leave these off until after the first successful supervised window:
- `claim.autoCompoundFees = true`
- aggressive trailing configuration
- any large capital increase
- any second process against the same runtime dir

## Operator Notes
- Single instance only.
- Keep capital small at first.
- Prefer `advisory` over stronger AI settings.
- Treat the first supervised live window as a validation exercise, not a yield-maximization phase.
