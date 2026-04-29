# Meridian V2 Repo Summary

Last updated: 2026-04-29

## High-Level Purpose

Meridian V2 is a TypeScript runtime for supervised Meteora DLMM liquidity operations on Solana. The system discovers candidate DLMM pools, applies deterministic risk filters, optionally asks AI for advisory/ranking/strategy review, and routes every trading write through an action queue.

Meteora DLMM pools are modeled around discrete liquidity bins. Important runtime concepts are `binStep`, `activeBin`, active-bin age/drift, range width, depth near the active bin, estimated slippage, and strategy style (`curve`, `spot`, `bid_ask`, or `none`).

## Architecture Map

- `src/domain`: pure entities, schemas, state machines, scoring, and safety rules. This is the deterministic core.
- `src/app`: use cases, workers, and application services. This orchestrates domain rules with repositories/gateways.
- `src/adapters`: real and mock integrations for Meteora DLMM, Meteora Pool Discovery, Jupiter, wallet/RPC, LLM, token intel, Telegram, and file-backed stores.
- `src/runtime`: live bootstrap, supervisor, store wiring, owner lock, and autonomous loop coordination.
- `src/infra`: config schema/loading, logging, locks, scheduler metadata, and IDs.
- `tests`: unit and integration coverage for lifecycle flows, screening, AI advisory, reconciliation, policy evolution, lessons, pool memory, and runtime supervisor behavior.

## Main Runtime Loops

- Startup recovery checks stale actions/positions before normal loops run.
- Action queue owns deploy, close, rebalance, claim, and post-claim swap writes.
- Reconciliation compares local state with wallet/DLMM reality and repairs or flags drift.
- Management evaluates open positions for hold, close, claim, or rebalance.
- Screening discovers pools, builds a deterministic shortlist, and can feed guarded auto-deploy.
- Reporting and operator commands expose runtime status, controls, lessons, and pool memory.

## Safety Model

- No AI path writes directly to chain. AI can advise, rank, or recommend strategy, but queue/rules decide execution.
- `runtime.dryRun=true` prevents live queue processing.
- Runtime owner lock prevents two supervisors from using the same data directory.
- Wallet/position locks prevent concurrent mutation inside one process.
- Risk rules enforce portfolio caps, circuit breaker, reserve, exposure, daily loss, and deploy cadence.
- Deploy from shortlist must pass strategy validation, simulation when enabled, active-bin checks, slippage checks, and detail freshness gates.
- Pool memory can cool down recently bad pools so they do not re-enter shortlist too quickly.

## Screening Pipeline

1. `runScreeningCycle()` calls `screeningGateway.listCandidates()`.
2. Coarse screening intentionally relaxes detail-dependent filters, including freshness, token age, ATH distance, volume trend, and 24h fee-per-TVL.
3. `buildEnrichmentPlan()` selects top coarse candidates for `getCandidateDetails()` using `detailEnrichmentTopN`, `maxDetailRequestsPerCycle`, and the Meteora detail rate limiter.
4. Final deterministic screening runs with the full policy and produces the shortlist.
5. AI ranking is optional and must return the exact shortlist set, otherwise the system falls back to deterministic order.
6. Runtime supervisor can try auto-deploy from shortlist, but `StrategyDecisionValidator` blocks stale/missing detail with `DETAIL_NOT_FRESH_OR_MISSING`.

Current live-ish config highlights from `user-config.json`:

- `timeframe`: `1h`
- `aiReviewPoolSize`: `30`, used as deterministic shortlist limit in runtime wiring.
- `detailEnrichmentTopN`: `10`
- `maxDetailRequestsPerCycle`: `10`
- `requireFreshSnapshot`: `true`
- `requireDetailForDeploy`: `true`
- `allowSnapshotOnlyWatch`: `true`
- `allowedBinSteps`: `80`, `100`, `125`, `200`

## ShortlistCount 0 Finding

Symptom investigated:

- Raw pool universe can reach about 300 pools from Meteora Pool Discovery.
- `enrichmentSummary.hardFilterPassed` can show about 30.
- `shortlistCount` stayed 0.

Root cause:

- The displayed `hardFilterPassed` in the enrichment summary is the coarse pass count.
- Final shortlist uses the full screening policy.
- Before the fix, final hard filter rejected stale/missing strategy snapshots even when `allowSnapshotOnlyWatch=true`.
- Meteora details can still have `tokenIntelFetchedAt=null` when token-intel narrative is unavailable, so `isFreshEnoughForDeploy=false`.
- Result: candidates passed coarse screening, but final deterministic screening rejected them as `strategy snapshot is stale`, leaving no shortlist.

Fix applied:

- `screeningRules` now honors `allowSnapshotOnlyWatch` only when `requireDetailForDeploy=true`.
- Snapshot-only candidates may enter shortlist/reporting.
- Auto-deploy remains blocked by `StrategyDecisionValidator` via `DETAIL_NOT_FRESH_OR_MISSING`.
- `deployBlockedMissingDetailCount` now counts shortlisted candidates that are not fresh enough for deploy.

Relevant files:

- `src/domain/rules/screeningRules.ts`
- `src/app/usecases/runScreeningCycle.ts`
- `src/domain/rules/strategyDecisionRules.ts`
- `src/runtime/createRuntimeSupervisor.ts`
- `src/adapters/screening/MeteoraPoolDiscoveryScreeningGateway.ts`

## Debug Checklist For Screening

- Check `SCREENING_COMPLETED.after.shortlistCount`.
- Check `SCREENING_COMPLETED.after.enrichment.hardFilterPassed`; this is coarse pass count, not final shortlist pass count.
- Check `deployBlockedMissingDetailCount`; non-zero means candidates are watch/report-only and not deploy-ready.
- Check `METEORA_DETAIL_RATE_LIMITED` and `METEORA_DETAIL_COOLDOWN_STARTED` for 429/cooldown.
- Check whether token intel is configured and returning narrative snapshots; missing token intel can keep `isFreshEnoughForDeploy=false`.
- Check final candidate `decisionReason`; `strategy snapshot is stale` means freshness/detail gating is the blocker.

## Verification

Targeted tests after the shortlist fix:

- `npm test -- tests/unit/screeningRules.test.ts`
- `npm test -- tests/unit/screeningWorker.test.ts`
- `npm run typecheck:all`
- `npm test`

All passed on 2026-04-29.
