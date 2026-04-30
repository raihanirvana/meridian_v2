# Runtime Flow And Operator Commands

Last updated: 2026-04-30

## Purpose

This document maps the live runtime flow for deploy, rebalance, close, and
manual operator commands. It is meant for audit and live ops: when something is
queued, this shows which function usually touched it first and what should
happen next.

## Runtime Entry Points

Live boot starts from:

1. `npm run live`
2. `src/runtime/runLive.ts`
3. `createRuntimeStores()`
4. `createRuntimeSupervisorFromUserConfig()`
5. startup recovery
6. startup recommended cycle
7. periodic timers

Main supervisor ticks are implemented in
`src/runtime/createRuntimeSupervisor.ts`:

- `runScreeningTick()`
- `runReconciliationTick()`
- `runManagementTick()`
- `runActionQueueTick()`
- `runReportingTick()`
- `runRecommendedCycle()`

Every live write should become an action first. The queue then processes that
action. AI can rank, recommend, and explain, but AI does not write directly to
chain.

## Deploy Flow

### Screening To Shortlist

Deploy discovery starts from the screening worker:

1. `runScreeningTick()`
2. `runScreeningWorker()`
3. `runScreeningCycle()`
4. `screeningGateway.listCandidates()`
5. deterministic screening rules
6. detail enrichment via `getCandidateDetails()`
7. final hard filter
8. shortlist creation
9. optional AI ranking via `rankShortlistWithAi()`
10. `SCREENING_COMPLETED` journal event

Important terms:

- `hardFilterPassed`: candidates that pass the required deterministic gates.
- `shortlistCount`: candidates selected from the filtered/ranked result for
  further review.
- `deployBlockedMissingDetailCount`: shortlist candidates that can be watched
  but are not deploy-ready because detail/freshness is missing.

### Auto Deploy From Shortlist

Auto deploy is handled after screening inside
`maybeAutoDeployFromShortlist()` in `src/runtime/createRuntimeSupervisor.ts`.

Current live flow:

1. Check `deploy.autoDeployFromShortlist`.
2. Check dry-run mode restrictions.
3. Check manual circuit breaker.
4. Build portfolio state.
5. Check max concurrent positions.
6. Check pending actions.
7. Check new deploys per hour.
8. Filter shortlist to SOL-paired candidates only.
9. Refresh deploy readiness with live pool info.
10. Send eligible candidates to `reviewStrategyWithAi()`.
11. Sort AI-reviewed candidates by:
    - AI `deploy` before `watch`
    - confidence descending
    - deterministic score descending
    - original order
12. Write `AI_STRATEGY_SHORTLIST_ORDERED`.
13. Validate final strategy via `validateStrategyDecision()`.
14. Simulate deploy when guarded/dry-run payload mode requires it.
15. Evaluate portfolio risk.
16. Create deploy action with `requestDeploy()`.

If the shortlist has only non-SOL pairs, auto deploy is skipped with:

```text
auto deploy skipped because shortlist has no SOL-paired candidates
```

### Deploy Action Processing

Once an action exists:

1. `runActionQueueTick()`
2. `processActionQueue()`
3. `processDeployAction()`
4. transition position to `DEPLOYING`
5. call `dlmmGateway.deployLiquidity()`
6. action becomes `WAITING_CONFIRMATION`
7. reconciliation confirms deploy
8. `confirmDeployAction()`
9. position becomes `OPEN`
10. action becomes `DONE`

Main journal events:

- `ACTION_ENQUEUED`
- `DEPLOY_REQUEST_ACCEPTED`
- `AUTO_DEPLOY_FROM_SHORTLIST`
- `ACTION_RUNNING`
- `DEPLOY_SUBMITTED`
- `ACTION_FINALIZED`
- `DEPLOY_CONFIRMED`

## Management Flow

Management is the loop that decides whether an existing open position should be
held, claimed, rebalanced, partially closed, or closed.

1. `runManagementTick()`
2. `runManagementWorker()`
3. `runManagementCycle()`
4. list local `OPEN` positions
5. build portfolio state
6. call live signal provider
7. optionally record pool memory snapshot
8. call `evaluateManagementAction()`
9. optionally ask AI for management explanation via `adviseManagementDecision()`
10. enqueue close, claim, partial close, or rebalance action

Live signal provider is created in `src/runtime/runLive.ts` by
`createConservativeSignalProvider()`. It currently provides:

- `claimableFeesUsd`
- out-of-range / near-edge rebalance improvement signal
- conservative false values for emergency token/liquidity flags

Important management rules in `src/domain/rules/managementRules.ts`:

- emergency close
- stop loss
- max hold time
- max out-of-range time
- severe negative yield
- trailing take profit
- reconcile-only guard
- zero-fee stale-position close
- claim fees threshold
- partial close target
- rebalance trigger
- hold

Zero-fee close config:

```json
{
  "closeZeroFeePositionsEnabled": true,
  "zeroFeeCloseMinAgeMinutes": 240,
  "zeroFeeCloseMaxClaimableFeesUsd": 0.01
}
```

That means: if a position is at least 240 minutes old and claimable fees are at
or below 0.01 USD, management can request `CLOSE`.

## Rebalance Flow

Rebalance starts from management. A rebalance is considered only when the
deterministic management rules return `REBALANCE`.

### Rebalance Decision

1. `runManagementCycle()`
2. `evaluateManagementAction()`
3. rule detects invalid range or near-edge range
4. `expectedRebalanceImprovement` must be true
5. rebalance count must be below policy max
6. optional AI rebalance review with `reviewRebalanceWithAi()`
7. `validateRebalanceDecision()`
8. optional planner builds redeploy payload
9. risk check
10. enqueue action with `requestRebalance()`

Live same-pool rebalance planning is wired through
`createLiveAiRebalancePlanner()` in `src/runtime/runLive.ts`.

### Rebalance Action Processing

1. `runActionQueueTick()`
2. `processActionQueue()`
3. `processRebalanceAction()`
4. close current position through `dlmmGateway.closePosition()`
5. action waits for confirmation/reconciliation as needed
6. `finalizeRebalance()`
7. finalize close leg
8. submit redeploy leg through `dlmmGateway.deployLiquidity()`
9. confirm redeploy
10. old position closes, new position opens, action becomes `DONE`

Main rebalance files:

- `src/app/usecases/requestRebalance.ts`
- `src/app/usecases/processRebalanceAction.ts`
- `src/app/usecases/finalizeRebalance.ts`
- `src/app/usecases/reviewRebalanceWithAi.ts`
- `src/domain/rules/rebalanceDecisionRules.ts`
- `src/runtime/liveRebalancePlanner.ts`

Main journal events to watch:

- `REBALANCE_REQUEST_ACCEPTED`
- `ACTION_RUNNING`
- rebalance close/redeploy events
- `ACTION_FINALIZED`
- `POSITION_RECONCILED`
- `RECONCILIATION_REQUIRED`

## Close Flow

Close can come from a manual operator command, management, startup recovery, or
rebalance close leg.

### Close Request

Manual/operator close:

1. `parseOperatorCommand()`
2. `executeOperatorCommand()`
3. active action guard
4. portfolio risk check
5. `requestClose()`
6. position transitions to `CLOSE_REQUESTED`
7. close action is queued

Management close:

1. `runManagementCycle()`
2. `evaluateManagementAction()`
3. action is `CLOSE`
4. optional AI advisory/explanation
5. risk check
6. `requestClose()`

### Close Action Processing

1. `runActionQueueTick()`
2. `processActionQueue()`
3. `processCloseAction()`
4. position transitions to `CLOSING`
5. call `dlmmGateway.closePosition()`
6. action becomes `WAITING_CONFIRMATION`
7. reconciliation/finalization confirms close
8. `finalizeClose()`
9. accounting summary is written
10. optional post-close swap runs
11. position becomes `CLOSED`
12. action becomes `DONE`

Main close files:

- `src/app/usecases/requestClose.ts`
- `src/app/usecases/processCloseAction.ts`
- `src/app/usecases/finalizeClose.ts`
- `src/app/services/AccountingService.ts`
- `src/app/usecases/executePostClaimSwap.ts`
- `src/app/usecases/reconcilePortfolio.ts`

Main journal events:

- `CLOSE_REQUEST_ACCEPTED`
- `ACTION_RUNNING`
- `CLOSE_SUBMITTING`
- `CLOSE_SUBMITTED`
- `ACTION_FINALIZED`
- `CLOSE_FINALIZED`
- `POSITION_RECONCILED`
- `RECONCILIATION_REQUIRED`

If Meteora shows the close succeeded but local action is still
`WAITING_CONFIRMATION`, do not edit JSON manually first. Let reconciliation run
or restart the supervisor cleanly so startup recovery can finalize the action.

## Reconciliation Flow

Reconciliation repairs local state when action submission and on-chain reality
diverge.

1. `runReconciliationTick()`
2. `runReconciliationWorker()`
3. `reconcilePortfolio()`
4. compare local positions/actions with DLMM/wallet reality
5. confirm submitted deploy/close/rebalance if chain state proves it
6. call `finalizeClose()` or `finalizeRebalance()` where appropriate
7. mark manual reconciliation only if automatic recovery is unsafe

Use this when actions are stuck:

```bash
jq '.[] | {actionId,type,status,positionId,requestedAt,startedAt,completedAt,error,txIds,resultPayload}' .local-data/actions.json
```

And journal:

```bash
tail -f .local-data/journal.jsonl | jq 'select(.eventType|test("RECONCILIATION|POSITION_RECONCILED|CLOSE|DEPLOY|REBALANCE|FAILED|ERROR|TIMED_OUT")) | {t:.timestamp,event:.eventType,status:.resultStatus,pos:.positionId,action:.actionId,err:.error}'
```

## Manual Operator Commands

Operator stdin is enabled when:

```json
{
  "runtime": {
    "operatorStdinEnabled": true
  }
}
```

Run live inside tmux:

```bash
cd /root/meredian/meridian_v2
tmux new -ds meridian 'cd /root/meredian/meridian_v2 && MERIDIAN_DATA_DIR=/root/meredian/meridian_v2/.local-data npm run live'
```

Send commands into the running session:

```bash
tmux send-keys -t meridian 'positions' C-m
tmux send-keys -t meridian 'status' C-m
tmux send-keys -t meridian 'pending-actions' C-m
```

### Manual Close

```bash
tmux send-keys -t meridian 'close POSITION_ID reason text here' C-m
```

Example:

```bash
tmux send-keys -t meridian 'close 7hwFm9bsCeGu37W2gbiqsQhF6Fvu9aMb19FcaGdjFzbQ manual close: zero fees after long hold' C-m
```

### Manual Deploy

Manual deploy expects a JSON payload after `deploy`.

```bash
tmux send-keys -t meridian 'deploy {"poolAddress":"POOL","tokenXMint":"TOKEN_X","tokenYMint":"So11111111111111111111111111111111111111112","baseMint":"TOKEN_X","quoteMint":"So11111111111111111111111111111111111111112","amountBase":0,"amountQuote":0.2,"slippageBps":300,"strategy":"curve","rangeLowerBin":-412,"rangeUpperBin":-332,"initialActiveBin":-352,"estimatedValueUsd":16.6}' C-m
```

For safety, prefer auto-deploy unless you have fresh pool info and a known
range.

### Manual Rebalance

Manual rebalance expects position id plus a JSON payload.

```bash
tmux send-keys -t meridian 'rebalance POSITION_ID {"reason":"manual rebalance","redeploy":{"poolAddress":"POOL","tokenXMint":"TOKEN_X","tokenYMint":"So11111111111111111111111111111111111111112","baseMint":"TOKEN_X","quoteMint":"So11111111111111111111111111111111111111112","amountBase":0,"amountQuote":0.2,"slippageBps":300,"strategy":"curve","rangeLowerBin":-412,"rangeUpperBin":-332,"initialActiveBin":-352,"estimatedValueUsd":16.6}}' C-m
```

For safety, prefer management-triggered rebalance because it has fresh active
bin, AI review, simulation, and risk checks wired into the normal path.

### Circuit Breaker

Stop new deploy/rebalance requests:

```bash
tmux send-keys -t meridian 'circuit_breaker_trip reason text here' C-m
```

Clear it:

```bash
tmux send-keys -t meridian 'circuit_breaker_clear' C-m
```

### Pool Memory Commands

```bash
tmux send-keys -t meridian 'pool memory POOL_ADDRESS' C-m
tmux send-keys -t meridian 'pool note POOL_ADDRESS note text here' C-m
tmux send-keys -t meridian 'pool cooldown POOL_ADDRESS 12' C-m
tmux send-keys -t meridian 'pool cooldown_clear POOL_ADDRESS' C-m
```

### Lessons Commands

```bash
tmux send-keys -t meridian 'lessons list --role MANAGER --limit 20' C-m
tmux send-keys -t meridian 'lessons add --role MANAGER --tag close zero-fee positions older than 4h should close' C-m
tmux send-keys -t meridian 'lessons pin LESSON_ID' C-m
tmux send-keys -t meridian 'lessons unpin LESSON_ID' C-m
tmux send-keys -t meridian 'lessons remove LESSON_ID' C-m
```

### Performance Commands

```bash
tmux send-keys -t meridian 'performance summary' C-m
tmux send-keys -t meridian 'performance-history 24 20' C-m
```

## Common VPS Inspection Commands

Open positions:

```bash
jq -r '.[] | select(.status=="OPEN") | [.positionId, .entryMetadata.poolName, .status, .currentValueUsd, .unrealizedPnlUsd, .feesClaimedUsd] | @tsv' .local-data/positions.json
```

Actions:

```bash
jq '.[] | {actionId,type,status,positionId,requestedAt,startedAt,completedAt,error,txIds,resultPayload}' .local-data/actions.json
```

AI strategy reviews and ordering:

```bash
jq 'select(.eventType=="AI_STRATEGY_SHORTLIST_ORDERED" or .eventType=="AI_STRATEGY_REVIEWED" or .eventType=="STRATEGY_DECISION_VALIDATED") | {t:.timestamp,event:.eventType,pool:.after.symbolPair,poolAddress:.after.poolAddress,order:.after.orderedCandidates,review:.after.review,final:.after.finalStrategyDecision,err:.error}' .local-data/journal.jsonl
```

Lifecycle tail:

```bash
tail -f .local-data/journal.jsonl | jq '{t:.timestamp,event:.eventType,status:.resultStatus,pos:.positionId,action:.actionId,err:.error}'
```

## Shutdown Procedure

If you want to stop after a close:

1. Send close command.
2. Trip circuit breaker.
3. Wait for close action `DONE`.
4. Kill tmux session.

Commands:

```bash
tmux send-keys -t meridian 'close POSITION_ID manual close before shutdown' C-m
tmux send-keys -t meridian 'circuit_breaker_trip shutdown after manual close' C-m
jq '.[] | {actionId,type,status,positionId,completedAt,error}' .local-data/actions.json
tmux kill-session -t meridian
```
