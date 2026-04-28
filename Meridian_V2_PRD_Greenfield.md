# Meridian V2 PRD

## 1. Ringkasan

Meridian V2 adalah rebuild total untuk bot manajemen likuiditas Meteora DLMM di Solana dengan prinsip **deterministic-first, AI-assisted, event-driven, dan testable**.

V2 **bukan** full AI bot. AI hanya menjadi lapisan tambahan untuk:

- ranking kandidat,
- memberi reasoning,
- membantu operator manual,
- dan memberi saran strategi.

Seluruh lifecycle yang berisiko tinggi wajib dipegang core engine yang deterministic:

- deploy,
- close,
- partial close,
- rebalance,
- reconcile,
- accounting,
- dan risk controls.

Target utama V2:

1. Menghilangkan flow “tambal sulam” yang menyebabkan bug baru terus muncul.
2. Menjadikan status posisi dan action **eksplisit** dan bisa ditelusuri.
3. Memisahkan loop baca dan loop tulis.
4. Menjadikan semua write action masuk lewat queue terkontrol.
5. Membuat batch pembangunan kecil agar cocok untuk vibecode dan meminimalkan regresi.

---

## 2. Latar Belakang Masalah

Versi lama menunjukkan pola bug yang berulang pada area fondasi:

- close belum final tetapi state dianggap selesai,
- rebalance membuka posisi baru sebelum close benar-benar tuntas,
- state internal dapat berbeda dari data on-chain/API,
- tool write dapat jalan paralel,
- health check berpotensi melakukan write,
- statistik performa bias karena reconciliation belum tegas,
- fitur AI, scheduler, dan executor saling bertumpuk tanpa boundary yang ketat.

Masalah utama bukan sekadar satu-dua bug, melainkan **desain lifecycle dan orchestration** yang belum diformalkan.

Karena itu V2 harus dibangun sebagai **engine baru** dari nol (**greenfield build**), dengan spesifikasi yang berdiri sendiri. Repo lama boleh dipakai hanya sebagai referensi perilaku, daftar rule, dan validasi hasil, tetapi **bukan** sebagai dependensi implementasi atau basis struktur kode.

---

## 3. Tujuan Produk

### 3.1 Tujuan utama

- Menjalankan screening, deploy, management, rebalance, dan close posisi secara stabil.
- Menjaga state posisi selalu konsisten dengan data chain/API.
- Menyimpan audit trail lengkap untuk setiap write action.
- Mengurangi bug dengan memaksa semua flow melewati state machine dan action queue.
- Tetap memberi ruang untuk AI, tetapi hanya sebagai layer opsional dan aman.

### 3.2 Non-goals awal V2

Fitur-fitur ini **tidak wajib di batch awal**:

- self-evolving strategy otomatis,
- adaptive screening super kompleks,
- multi-wallet orchestration,
- Discord auto-ingest penuh,
- portfolio optimizer canggih,
- strategy generator bebas oleh AI.

### 3.3 Kebijakan terhadap repo lama

- V2 **harus bisa dibangun dari nol** tanpa copy file atau folder dari repo lama.
- Repo lama **tidak wajib** dipakai saat coding.
- Repo lama hanya boleh dipakai sebagai bahan audit untuk tiga hal:
  1. daftar rule bisnis yang ingin dipertahankan,
  2. daftar edge case yang pernah gagal,
  3. pembanding output saat UAT atau migration test.
- Tidak ada modul di V2 yang boleh diasumsikan impor, reuse, atau bergantung ke struktur repo lama.
- Jika ada logic lama yang ingin dipertahankan, logic itu harus ditulis ulang mengikuti kontrak V2, test V2, dan state machine V2.

---

## 4. Prinsip Arsitektur

1. **Deterministic first**  
   Lifecycle inti tidak boleh bergantung pada prompt LLM.

2. **Single writer principle**  
   Semua write action lewat satu action queue/worker per wallet.

3. **Explicit state machine**  
   Tidak boleh ada status implisit seperti “mungkin sudah close karena hilang dari snapshot”.

4. **Reconciliation is mandatory**  
   Tiap action write harus punya tahap verifikasi dan finalisasi accounting.

5. **AI is advisory unless explicitly allowed**  
   AI boleh merekomendasikan, tetapi eksekusi tetap divalidasi engine.

6. **Read loops and write loops must be separated**  
   Health/reporting tidak boleh memegang tool write.

7. **Every action must be journaled**  
   Semua aksi punya event log, status, input, output, dan idempotency key.

8. **Build small, test small**  
   Rebuild dipecah banyak batch kecil agar vibecode tetap presisi.

---

## 5. Definisi Produk V2

### 5.1 Apa yang dilakukan Meridian V2

- Screening pool DLMM berdasarkan hard filters dan scoring.
- Memilih candidate terbaik untuk deploy berdasarkan deterministic scoring; AI opsional untuk ranking akhir.
- Mengizinkan AI, dalam mode terbatas, memberi rekomendasi strategi DLMM (`spot`, `curve`, `bid_ask`), range bin, slippage, dan parameter exit, tetapi selalu divalidasi rules engine sebelum dipakai.
- Membuka posisi baru secara aman.
- Memantau posisi yang sedang aktif.
- Menutup, partial close, claim fee, atau rebalance berdasarkan rules yang jelas.
- Menjalankan reconciliation setelah setiap write action.
- Menyimpan riwayat performa dan event audit.
- Mengirim ringkasan dan alert ke operator.

### 5.2 Siapa “otak” utama bot

V2 adalah **hybrid system**:

- **Core engine**: deterministic rules + state machine + queue + reconciliation.
- **AI layer**: ranking, reasoning, operator interface, optional decision support.
- **Adapters**: DLMM/Jupiter/analytics/Telegram/LLM/storage.

---

## 6. Arsitektur V2

## 6.1 Layer utama

### A. Domain layer

Pure business logic, tanpa IO.

- entities
- value objects
- rules
- state machines
- scoring
- policy validation

### B. Application layer

Use cases dan workers.

- screen market
- decide deploy
- request close
- finalize close
- request rebalance
- process queue
- reconcile positions
- generate reports

### C. Adapter layer

Integrasi dengan dunia luar.

- Meteora/DLMM adapter
- Jupiter swap adapter
- Screening API adapter
- OKX/onchain analytics adapter
- Telegram adapter
- LLM adapter
- file/db storage adapter

### D. Infrastructure layer

- config loader
- locks
- scheduler
- logger
- metrics
- persistence

---

## 6.2 Struktur folder yang disarankan

```txt
src/
  domain/
    entities/
      Position.ts
      Candidate.ts
      Action.ts
      PortfolioState.ts
    rules/
      screeningRules.ts
      managementRules.ts
      rebalanceRules.ts
      riskRules.ts
      accountingRules.ts
      poolFeatureRules.ts
      strategyDecisionRules.ts
    scoring/
      candidateScore.ts
      managementPriority.ts
      strategySuitabilityScore.ts
    stateMachines/
      positionLifecycle.ts
      actionLifecycle.ts
    types/
      enums.ts
      schemas.ts

  app/
    usecases/
      screenMarket.ts
      buildCandidateDetails.ts
      decideDeploy.ts
      reviewStrategyWithAi.ts
      requestDeploy.ts
      requestClose.ts
      requestPartialClose.ts
      requestRebalance.ts
      finalizeClose.ts
      reconcilePortfolio.ts
      processActionQueue.ts
    workers/
      screeningWorker.ts
      managementWorker.ts
      reconciliationWorker.ts
      reportingWorker.ts
      healthWorker.ts
    services/
      PositionService.ts
      CandidateService.ts
      ActionService.ts
      AccountingService.ts
      RiskService.ts

  adapters/
    dlmm/
      DlmmGateway.ts
    jupiter/
      SwapGateway.ts
    screening/
      ScreeningGateway.ts
    analytics/
      TokenIntelGateway.ts
    telegram/
      TelegramGateway.ts
    llm/
      LlmGateway.ts
      AiStrategyReviewer.ts
    storage/
      FileStore.ts
      StateRepository.ts
      JournalRepository.ts

  infra/
    config/
      loadConfig.ts
      configSchema.ts
    scheduler/
      scheduler.ts
    locks/
      walletLock.ts
      positionLock.ts
    metrics/
      metrics.ts
    logging/
      logger.ts

  cli/
  tests/
```

---

## 7. Model Domain Inti

## 7.1 Entity: Position

Field minimal:

- `positionId`
- `poolAddress`
- `tokenXMint`
- `tokenYMint`
- `baseMint`
- `quoteMint`
- `wallet`
- `status`
- `openedAt`
- `lastSyncedAt`
- `closedAt`
- `deployAmountBase`
- `deployAmountQuote`
- `currentValueBase`
- `currentValueUsd`
- `feesClaimedBase`
- `feesClaimedUsd`
- `realizedPnlBase`
- `realizedPnlUsd`
- `unrealizedPnlBase`
- `unrealizedPnlUsd`
- `rebalanceCount`
- `partialCloseCount`
- `strategy`
- `rangeLowerBin`
- `rangeUpperBin`
- `activeBin`
- `outOfRangeSince`
- `lastManagementDecision`
- `lastManagementReason`
- `lastWriteActionId`
- `needsReconciliation`

## 7.2 Entity: Candidate

- `candidateId`
- `poolAddress`
- `symbolPair`
- `tokenXMint`
- `tokenYMint`
- `baseMint`
- `quoteMint`
- `screeningSnapshot`
- `marketFeatureSnapshot`
- `dlmmMicrostructureSnapshot`
- `tokenRiskSnapshot`
- `smartMoneySnapshot`
- `dataFreshnessSnapshot`
- `hardFilterPassed`
- `score`
- `scoreBreakdown`
- `strategySuitability`
- `aiStrategyDecision` optional
- `finalStrategyDecision` optional
- `decision`
- `decisionReason`
- `createdAt`
- `lastReviewedAt`

### 7.2.1 Field tambahan screening wajib

`marketFeatureSnapshot` harus menampung minimal:

- `volume5mUsd`
- `volume15mUsd`
- `volume1hUsd`
- `volume24hUsd`
- `fees5mUsd`
- `fees15mUsd`
- `fees1hUsd`
- `fees24hUsd`
- `tvlUsd`
- `feeTvlRatio1h`
- `feeTvlRatio24h`
- `volumeTvlRatio1h`
- `volumeTvlRatio24h`
- `priceChange5mPct`
- `priceChange15mPct`
- `priceChange1hPct`
- `priceChange24hPct`
- `volatility5mPct`
- `volatility15mPct`
- `volatility1hPct`
- `trendStrength15m`
- `trendStrength1h`
- `meanReversionScore`
- `washTradingRiskScore`
- `organicVolumeScore`

`dlmmMicrostructureSnapshot` harus menampung minimal:

- `binStep`
- `activeBin`
- `activeBinSource`
- `activeBinObservedAt`
- `activeBinAgeMs`
- `activeBinDriftFromDiscovery`
- `depthNearActiveUsd`
- `depthWithin10BinsUsd`
- `depthWithin25BinsUsd`
- `liquidityImbalancePct`
- `spreadBps`
- `estimatedSlippageBpsForDefaultSize`
- `outOfRangeRiskScore`
- `rangeStabilityScore`

`dataFreshnessSnapshot` harus menampung minimal:

- `screeningSnapshotAt`
- `poolDetailFetchedAt`
- `tokenIntelFetchedAt`
- `chainSnapshotFetchedAt`
- `oldestRequiredSnapshotAgeMs`
- `isFreshEnoughForDeploy`

### 7.2.2 Strategy suitability

`strategySuitability` adalah hasil deterministic awal sebelum AI:

- `curveScore`
- `spotScore`
- `bidAskScore`
- `recommendedByRules` (`curve`, `spot`, `bid_ask`, `none`)
- `strategyRiskFlags`
- `reasonCodes`

AI boleh membaca field ini, tetapi tidak boleh mengabaikan hard reject dan tidak boleh memilih strategi di luar allowlist config.

## 7.3 Entity: Action

- `actionId`
- `type` (`DEPLOY`, `CLOSE`, `PARTIAL_CLOSE`, `CLAIM_FEES`, `REBALANCE`, `SWAP`, `SYNC`, `CANCEL_REBALANCE`)
- `status` (`QUEUED`, `RUNNING`, `WAITING_CONFIRMATION`, `RECONCILING`, `DONE`, `FAILED`, `ABORTED`, `TIMED_OUT`)
- `wallet`
- `positionId` optional
- `idempotencyKey`
- `requestPayload`
- `resultPayload`
- `txIds`
- `error`
- `requestedAt`
- `startedAt`
- `completedAt`
- `requestedBy` (`system`, `operator`, `ai`)

## 7.4 Entity: PortfolioState

- `walletBalance`
- `reservedBalance`
- `availableBalance`
- `openPositions`
- `pendingActions`
- `dailyRealizedPnl`
- `drawdownState`
- `circuitBreakerState`
- `exposureByToken`
- `exposureByPool`

---

## 8. State Machine Inti

## 8.1 Position lifecycle

```txt
DRAFT
  -> DEPLOY_REQUESTED
  -> DEPLOYING
  -> OPEN
  -> MANAGEMENT_REVIEW
  -> { HOLD | CLAIM_REQUESTED | PARTIAL_CLOSE_REQUESTED | REBALANCE_REQUESTED | CLOSE_REQUESTED }

CLAIM_REQUESTED
  -> CLAIMING
  -> CLAIM_CONFIRMED
  -> OPEN

PARTIAL_CLOSE_REQUESTED
  -> PARTIAL_CLOSING
  -> PARTIAL_CLOSE_CONFIRMED
  -> OPEN or CLOSE_REQUESTED

REBALANCE_REQUESTED
  -> CLOSING_FOR_REBALANCE
  -> CLOSE_CONFIRMED
  -> REDEPLOY_REQUESTED
  -> REDEPLOYING
  -> OPEN

CLOSE_REQUESTED
  -> CLOSING
  -> CLOSE_CONFIRMED
  -> RECONCILING
  -> CLOSED

Any state
  -> RECONCILIATION_REQUIRED
  -> RECONCILING
  -> previous safe state or CLOSED or FAILED

Any state
  -> FAILED
  -> ABORTED
```

### Aturan penting

- Posisi **tidak pernah langsung `CLOSED`** hanya karena hilang dari API snapshot.
- Posisi yang hilang dari snapshot masuk ke `RECONCILIATION_REQUIRED`.
- `REBALANCE` adalah dua fase resmi: close lama lalu deploy baru. Bukan satu shortcut.

## 8.2 Action lifecycle

```txt
QUEUED -> RUNNING -> WAITING_CONFIRMATION -> RECONCILING -> DONE
QUEUED -> RUNNING -> FAILED
WAITING_CONFIRMATION -> TIMED_OUT
FAILED -> RETRY_QUEUED (optional)
```

---

## 9. Core Logic Rules

## 9.1 Rule group A — Portfolio risk rules

Aturan global portofolio sebelum action write apa pun:

- `maxConcurrentPositions`
- `maxCapitalUsagePct`
- `minReserveSol`
- `maxTokenExposurePct`
- `maxPoolExposurePct`
- `maxOpenActionsPerWallet = 1`
- `maxRebalancesPerPosition`
- `dailyLossLimitPct`
- `circuitBreakerCooldownMin`
- `maxNewDeploysPerHour`

### Rule evaluasi

1. Jika circuit breaker aktif, tolak semua deploy baru.
2. Jika daily realized loss melewati limit, hanya izinkan close/claim/reconcile, tidak boleh deploy baru.
3. Jika available balance < deploy minimum + reserve, action deploy diblok.
4. Jika exposure token atau pool melampaui limit, candidate ditolak.
5. Jika ada action write aktif untuk wallet yang sama, jangan mulai write action baru.

---

## 9.2 Rule group B — Screening hard filters

Candidate pool harus lolos filter keras sebelum dihitung skornya:

- market cap minimum / maksimum
- TVL minimum
- volume minimum
- fee-to-TVL minimum
- organic score minimum
- holder count minimum
- bin step yang diizinkan
- launchpad blacklist
- token blacklist
- deployer blacklist
- top holder concentration maksimum
- bot holder ratio maksimum
- bundle risk maksimum
- wash trading risk maksimum
- pair type yang diizinkan
- duplicate token / duplicate pool exposure

### Output screening hard filters

Candidate hanya punya 2 hasil:

- `REJECTED_HARD_FILTER`
- `PASSED_HARD_FILTER`

AI tidak boleh mengoverride hard filter.

---

## 9.3 Rule group C — Candidate scoring

Setelah lolos hard filters, candidate diberi skor dari komponen deterministic:

- fee/TVL ratio
- volume consistency
- liquidity depth
- organic score
- holder quality
- top holder concentration
- token audit health
- smart money signal quality
- pool age / maturity
- launchpad or narrative penalties
- overlap penalty dengan posisi yang sudah ada

### Output scoring

- `scoreTotal`
- `scoreBreakdown`
- `riskFlags`

### AI di tahap ini

AI boleh digunakan untuk:

- ranking akhir dari shortlist top N,
- memberi catatan naratif,
- memilih antara kandidat yang skornya mirip.

AI **tidak boleh** men-deploy kandidat yang gagal hard filter.

---

## 9.4 Rule group D — Deploy rules

Sebelum deploy:

1. Candidate harus status `PASSED_HARD_FILTER`.
2. Candidate harus ada detail snapshot lengkap.
3. Candidate tidak boleh conflict dengan exposure rule.
4. Wallet harus punya saldo cukup.
5. Tidak boleh ada pending write action pada wallet.
6. Dry-run/live mode harus jelas.
7. Semua parameter deploy harus tervalidasi schema.

### Deploy execution rules

- Deploy selalu lewat action queue.
- Setelah tx submit, status action jadi `WAITING_CONFIRMATION`.
- Setelah confirm sukses, position status jadi `OPEN`.
- Jika tx gagal/timeout, state kembali aman dan journal ditulis.

---

## 9.5 Rule group E — Management evaluation order

Untuk setiap posisi `OPEN`, evaluasi dilakukan **berurutan dan deterministic**:

1. **Emergency rules**
   - circuit breaker global
   - rug pull / severe token risk
   - liquidity collapse
   - forced manual close

2. **Hard exit rules**
   - stop loss tercapai
   - max hold time tercapai
   - out of range terlalu lama
   - severe negative yield condition

3. **Maintenance rules**
   - claim fees jika threshold tercapai
   - partial close jika profit target dan rule aktif
   - rebalance jika range invalid tetapi masih layak dipertahankan

4. **Hold rule**
   - jika semua kondisi aman, status `HOLD`

### Output management engine

Harus berupa salah satu action resmi:

- `HOLD`
- `CLAIM_FEES`
- `PARTIAL_CLOSE`
- `REBALANCE`
- `CLOSE`
- `RECONCILE_ONLY`

AI boleh memberi reasoning tambahan, tetapi tidak boleh membuat action di luar enum di atas.

---

## 9.6 Rule group F — Close rules

Close dilakukan jika salah satu kondisi terpenuhi:

- hard stop loss tercapai,
- token risk melonjak di atas ambang,
- posisi out of range melebihi maksimum,
- max hold time tercapai,
- manual operator memerintahkan close,
- rebalance membutuhkan close posisi lama.

### Aturan close yang wajib

- Close action harus idempotent.
- Setelah tx submit, posisi masuk `CLOSING`.
- Jika belum ada konfirmasi final, posisi **tetap tidak boleh dideploy ulang** kecuali flow resmi rebalance menunggu finalizer.
- Setelah close confirm, sistem wajib menjalankan finalizer accounting.

---

## 9.7 Rule group G — Rebalance rules

Rebalance hanya boleh jika:

- posisi tidak melanggar hard stop,
- alasan utama adalah range drift atau efficiency drop,
- rebalance count belum melewati limit,
- pool/token masih lolos risk check,
- expected outcome lebih baik daripada hold/close,
- tidak ada circuit breaker.

### Rebalance flow resmi

1. enqueue `CLOSE_FOR_REBALANCE`
2. tunggu `CLOSE_CONFIRMED`
3. jalankan `FINALIZE_CLOSE`
4. hitung modal tersedia pasca-close
5. validasi ulang deploy target
6. enqueue `REDEPLOY`
7. jika redeploy gagal permanen, posisi lama tetap dianggap `CLOSED`, dan sistem menulis event `REBALANCE_ABORTED`

### Larangan penting

- Tidak boleh deploy baru sebelum close lama finalized.
- Tidak boleh menganggap rebalance sukses hanya karena posisi lama hilang dari snapshot.

---

## 9.8 Rule group H — Reconciliation rules

Reconciliation adalah proses resmi, bukan fallback informal.

Sistem harus menjalankan reconciliation jika:

- action status `WAITING_CONFIRMATION` terlalu lama,
- posisi hilang dari snapshot,
- nilai PnL/API tidak lengkap,
- ada restart di tengah action,
- state storage berbeda dengan hasil chain/API.

### Output reconciliation

- `RECONCILED_OK`
- `REQUIRES_RETRY`
- `MANUAL_REVIEW_REQUIRED`

### Prinsip

- “Tidak terlihat di API” ≠ “closed final”.
- Reconciliation harus mencoba melengkapi:
  - tx status,
  - final token balances,
  - realized PnL,
  - fee claimed,
  - post-close swap status,
  - accounting journal.

---

## 9.9 Rule group I — Accounting rules

Accounting wajib update saat:

- deploy confirmed,
- claim fees confirmed,
- partial close confirmed,
- close confirmed,
- rebalance old leg finalized,
- manual swap confirmed.

### Data yang harus tersimpan

- cost basis,
- realized PnL,
- unrealized PnL,
- fees accrued,
- fees claimed,
- action costs,
- daily realized PnL,
- portfolio equity snapshot.

### Prinsip

- Statistik performa hanya boleh diambil dari data yang sudah `RECONCILED_OK`.
- Pending close tidak boleh dihitung final win/loss dulu.

---

## 9.10 Rule group J — AI guardrails

AI hanya boleh:

- membaca snapshot posisi/kandidat,
- memberi ranking,
- memberi reasoning,
- memberi saran manual,
- mengusulkan action valid.

AI tidak boleh:

- menulis state langsung,
- mem-bypass queue,
- mengubah config rahasia,
- memanggil write tool di luar whitelist worker,
- mengoverride hard risk rules.

### Mode AI

1. **Disabled** — bot tetap jalan deterministically.
2. **Advisory** — AI memberi ranking/reasoning saja.
3. **Constrained action** — AI boleh memilih satu action dari daftar action yang sudah diizinkan engine.

Mode default V2 untuk lifecycle inti: **Advisory**.

---

## 9.11 Rule group K — AI Strategy Selector untuk deploy

AI Strategy Selector adalah layer opsional setelah hard filter dan scoring deterministic.
Tujuannya bukan mengganti rules engine, melainkan memberi rekomendasi strategi DLMM untuk kandidat yang sudah layak.

### Input minimal ke AI Strategy Selector

- candidate identity: `poolAddress`, `symbolPair`, mints
- score deterministic dan `scoreBreakdown`
- `marketFeatureSnapshot`
- `dlmmMicrostructureSnapshot`
- `tokenRiskSnapshot`
- `smartMoneySnapshot`
- portfolio context: open positions, max deploy size, daily loss remaining, exposure
- allowed strategies dari config

### Output wajib AI

AI wajib mengembalikan JSON ketat:

- `poolAddress`
- `decision` (`deploy`, `watch`, `reject`)
- `recommendedStrategy` (`curve`, `spot`, `bid_ask`, `none`)
- `confidence` 0..1
- `riskLevel` (`low`, `medium`, `high`)
- `binsBelow`
- `binsAbove`
- `slippageBps`
- `maxPositionAgeMinutes`
- `stopLossPct`
- `takeProfitPct`
- `trailingStopPct`
- `reasons[]`
- `rejectIf[]`

### Validator wajib setelah AI

`StrategyDecisionValidator` harus menolak rekomendasi AI jika:

- candidate gagal hard filter,
- score deterministic di bawah threshold,
- AI confidence di bawah `minAiStrategyConfidence`,
- `riskLevel = high`,
- strategy tidak ada di allowlist,
- `binsBelow` atau `binsAbove` melebihi batas config,
- `slippageBps` melebihi `maxSlippageBps`,
- snapshot tidak fresh,
- active bin drift melebihi `maxActiveBinDrift`,
- exposure/capital/risk rule gagal,
- simulation DLMM gagal.

### Prinsip final

AI boleh memilih strategi. Rules engine memberi izin. Simulation membuktikan aman. Baru action queue boleh submit.

---

## 9.12 Rule group L — Strategy suitability deterministic

Sebelum AI dipanggil, engine harus menghitung kecocokan strategi secara deterministic agar AI tidak bekerja dari data mentah saja.

### Curve cocok jika

- volatilitas rendah,
- harga sideways,
- volume stabil,
- depth dekat active bin cukup,
- token risk rendah,
- pair relatif mature atau stable-ish.

### Spot cocok jika

- volatilitas sedang,
- trend tidak terlalu kuat,
- volume/TVL sehat,
- depth cukup merata,
- strategi butuh buffer simetris.

### Bid-Ask cocok jika

- volatilitas tinggi tetapi mean-reverting,
- volume besar dan relatif organik,
- depth cukup untuk default size,
- spread/slippage masih aman,
- tidak sedang pump/dump satu arah.

### Reject strategy jika

- snapshot stale,
- active bin berubah terlalu jauh,
- depth terlalu dangkal,
- price move 5m/15m ekstrem,
- fee/TVL terlihat tidak realistis,
- token risk memburuk,
- data sumber tidak lengkap.

---

## 10. Scheduler Rules

V2 punya 4 worker utama:

- `screeningWorker`
- `managementWorker`
- `reconciliationWorker`
- `reportingWorker`

### Aturan scheduler

- Screening worker hanya read-only sampai enqueue deploy.
- Management worker boleh membuat request action, tetapi tidak eksekusi write langsung di tempat.
- Action queue worker adalah satu-satunya komponen yang menulis ke chain.
- Reconciliation worker jalan periodik dan setelah action confirmation timeout.
- Health/reporting worker read-only penuh.

### Penting

- Timer yang dipakai UI/countdown harus bersumber dari scheduler state yang sama.
- Manual trigger harus memperbarui metadata run yang sama, agar tidak terjadi double fire tidak sengaja.

---

## 11. Persistence dan Audit Trail

## 11.1 Repository yang dibutuhkan

- `positions.json` / database tabel positions
- `actions.json` / table actions
- `journal.jsonl` / event log append-only
- `performance.json`
- `portfolio_snapshots.json`
- `candidates_cache.json`
- `config.json` dan `.env`

## 11.2 Event journal wajib memuat

- timestamp
- event type
- actor (`system`, `operator`, `ai`)
- wallet
- positionId / actionId
- payload sebelum dan sesudah
- tx ids
- result status
- error jika ada

### Prinsip

Audit trail harus cukup lengkap untuk menjawab:

- siapa melakukan action,
- kapan,
- atas dasar apa,
- hasilnya apa,
- dan state berubah menjadi apa.

---

## 12. Security dan Config

## 12.1 Boundary config

### `.env`

Hanya untuk secret:

- wallet private key
- API keys
- RPC URLs
- Telegram bot token

### `user-config.json`

Hanya untuk non-secret:

- risk limits
- screening thresholds
- intervals
- mode AI
- deploy sizing
- notification preferences

## 12.2 Rules

- Jangan pernah tulis private key ke state log.
- Jangan commit `.env`, runtime config, `.git`, atau tmp runtime files ke paket distribusi.
- Semua config di-validate dengan schema saat startup.
- Unknown config keys harus ditolak atau diperingatkan keras.

---

## 13. Observability

Wajib ada:

- structured logs,
- event journal,
- action status board,
- last successful sync timestamp,
- pending reconciliation count,
- queue depth,
- open positions summary,
- daily realized PnL summary,
- alert untuk action stuck.

### Alert minimal

- close pending > X menit
- action timeout
- queue backlog terlalu lama
- reconciliation gagal
- daily loss limit hit
- circuit breaker on/off
- wallet balance di bawah reserve

---

## 14. Testing Strategy

## 14.1 Unit tests

Untuk pure rules/domain:

- hard filters
- scoring
- management decision ordering
- risk rule precedence
- state machine transitions
- accounting calculations

## 14.2 Integration tests

Dengan mocked adapters:

- deploy success/fail/timeout
- close success/fail/timeout
- rebalance success/redeploy fail
- claim then reconcile
- disappearance from snapshot -> reconcile, not auto-close
- restart while action pending

## 14.3 Simulation tests

Dry-run end-to-end:

- single candidate deploy
- single position managed over time
- stop loss scenario
- out-of-range rebalance scenario
- API inconsistent scenario
- circuit breaker scenario

## 14.4 Regression suite wajib

Sebelum live:

1. close-confirmation path
2. close-timeout path
3. rebalance finalized path
4. rebalance aborted path
5. false disappearance path
6. manual close via operator path
7. no-write health check path
8. sequential write guarantee path

---

## 15. Definisi Selesai untuk V2 MVP

Meridian V2 dianggap siap untuk supervised live testing jika:

- deploy, close, partial close, claim, dan rebalance sudah lewat queue + reconciliation,
- tidak ada auto-close berbasis disappearance semata,
- health worker read-only,
- write actions sequential per wallet,
- accounting post-close valid,
- regression suite inti lulus,
- dry-run simulation stabil minimal beberapa siklus,
- config schema dan logging sudah rapi.

---

## 16. Batch Build Plan untuk Vibecode

Prinsip batch:

- kecil,
- testable,
- tidak terlalu banyak file sekaligus,
- tiap batch punya output yang jelas,
- AI coding session fokus pada satu jenis masalah.

> Rekomendasi: jangan mengaktifkan AI action layer sebelum batch 11/12. Bangun core deterministic dulu.

---

## Batch 0 — Repo reset dan standar proyek

### Tujuan

Menyiapkan repo V2 yang bersih dan mudah divalidasi.

### Bangun

- buat repo/folder baru `meridian-v2`
- pilih TypeScript
- setup eslint + prettier
- setup vitest/jest
- setup zod untuk schema
- setup logger (pino/winston/serupa)
- setup folder structure awal

### Output

- project bootstrap jalan
- test runner jalan
- lint jalan
- build jalan

### DoD

- `npm test` bisa jalan
- `npm run build` sukses
- ada 1 test dummy lolos

### Jangan dikerjakan dulu

- adapter nyata
- AI
- Telegram

### Prompt vibecode

“Bootstrap project TypeScript untuk bot trading event-driven. Buat folder domain/app/adapters/infra/tests, setup zod, logger, vitest, eslint, dan contoh 1 schema + 1 unit test. Jangan implement fitur trading dulu.”

---

## Batch 1 — Config schema dan environment boundary

### Tujuan

Memastikan secret vs non-secret tidak tercampur.

### Bangun

- `configSchema.ts`
- `loadConfig.ts`
- `.env.example`
- `user-config.example.json`
- validasi strict mode
- reject unknown keys atau beri warning eksplisit

### Output

- config terload dari `.env` dan `user-config.json`
- type-safe config object

### Tests

- secret harus dari `.env`
- key non-secret dari json
- invalid config melempar error
- unknown key tertangkap

### DoD

- startup gagal jika config invalid
- no secret leak ke log

### Prompt vibecode

“Implement strict config loader dengan zod. Pisahkan secret di .env dan non-secret di user-config.json. Tambahkan tests untuk invalid config, unknown keys, dan redacted logging.”

---

## Batch 2 — Domain enums, entities, dan state machine

### Tujuan

Menetapkan bahasa resmi sistem.

### Bangun

- enums action/status
- entity `Position`, `Action`, `Candidate`, `PortfolioState`
- `positionLifecycle.ts`
- `actionLifecycle.ts`

### Output

- state transition functions pure
- guard invalid transitions

### Tests

- valid transition OPEN -> CLOSE_REQUESTED -> CLOSING -> CLOSE_CONFIRMED -> RECONCILING -> CLOSED
- invalid transition OPEN -> CLOSED harus gagal
- rebalance state path valid

### DoD

- semua status resmi sudah ada
- tidak ada status implisit

### Prompt vibecode

“Buat domain entities dan explicit state machines untuk Position dan Action. Semua transition harus pure function, typed, dan punya unit tests untuk valid/invalid transitions.”

---

## Batch 3 — Persistence dan event journal

### Tujuan

Menyimpan state secara eksplisit dan bisa diaudit.

### Bangun

- `StateRepository`
- `JournalRepository`
- `ActionRepository`
- append-only event journal
- atomic write helper

### Output

- save/load position
- save/load action
- append journal event

### Tests

- persist + reload state
- journal append order
- atomic write tidak korup pada partial failure simulation

### DoD

- restart bisa memuat state sebelumnya
- journal konsisten

### Prompt vibecode

“Implement file-based repositories untuk positions, actions, dan append-only journal dengan atomic writes. Tambahkan integration tests untuk restart recovery dan journal ordering.”

---

## Batch 4 — Locks dan action queue dasar

### Tujuan

Membuat single-writer execution model.

### Bangun

- wallet lock
- position lock
- action queue
- queue processor skeleton
- idempotency key generator

### Output

- hanya 1 write action aktif per wallet
- action status bergerak dari QUEUED ke RUNNING

### Tests

- 2 action write ke wallet sama tidak boleh RUNNING bersamaan
- retry queue tidak membuat duplikasi action jika idempotency key sama

### DoD

- sequential write guarantee ada
- queue bisa pause/resume

### Prompt vibecode

“Buat action queue dengan single-writer lock per wallet dan optional lock per position. Tambahkan idempotency key dan tests yang membuktikan dua write action tidak bisa jalan paralel.”

---

## Batch 5 — Mock gateways dan contract interfaces

### Tujuan

Memisahkan domain dari vendor API.

### Bangun

- interface `DlmmGateway`, `SwapGateway`, `ScreeningGateway`, `TokenIntelGateway`, `LlmGateway`, `NotifierGateway`
- mock implementations untuk test

### Output

- domain/app layer belum tergantung vendor SDK langsung

### Tests

- mock gateway bisa dipakai untuk simulasikan success/fail/timeout

### DoD

- semua use case nantinya bergantung pada interface, bukan SDK langsung

### Prompt vibecode

“Define adapter interfaces for DLMM, swap, screening, token intel, LLM, and notifications. Provide mock implementations for success, fail, and timeout scenarios.”

---

## Batch 6 — Use case deploy end-to-end

### Tujuan

Menyelesaikan satu alur write paling sederhana.

### Bangun

- `requestDeploy.ts`
- `processDeployAction` di queue worker
- confirmation handling
- journal events deploy
- update position state ke OPEN saat confirmed

### Output

- deploy flow lengkap dari request sampai confirmed

### Tests

- deploy success
- deploy timeout
- deploy fail
- duplicate deploy request dengan idempotency key sama

### DoD

- deploy tidak mem-bypass queue
- posisi hanya OPEN jika confirmed

### Prompt vibecode

“Implement deploy use case via action queue. After submit, action waits for confirmation, then creates/updates a Position to OPEN. Add tests for success, fail, timeout, and duplicate request.”

---

## Batch 7 — Use case close + finalizer accounting

### Tujuan

Menutup posisi secara resmi dan tuntas.

### Bangun

- `requestClose.ts`
- `finalizeClose.ts`
- action lifecycle stays `QUEUED -> RUNNING -> WAITING_CONFIRMATION -> RECONCILING -> DONE`
- position lifecycle for close is `CLOSE_REQUESTED -> CLOSING -> CLOSE_CONFIRMED -> RECONCILING -> CLOSED`
- accounting update
- performance record update
- optional post-close swap hook interface

### Output

- close flow lengkap dan tidak berhenti di “pending” tanpa finalizer

### Tests

- close success lalu finalize accounting
- close timeout -> reconcile required
- close confirmed tapi accounting gagal -> reconcile required

### DoD

- posisi tidak pernah CLOSED tanpa finalizer

### Prompt vibecode

“Implement close use case with explicit finalizer. A position cannot become CLOSED until confirmation and accounting reconciliation succeed. Add tests for confirmed close, timeout, and partial reconciliation failure.”

---

## Batch 8 — Reconciliation worker

### Tujuan

Menangani state tidak sinkron secara resmi.

### Bangun

- `reconcilePortfolio.ts`
- `reconciliationWorker.ts`
- detection untuk missing snapshot, pending confirmation timeout, startup recovery

### Output

- posisi hilang dari snapshot masuk `RECONCILIATION_REQUIRED`, bukan auto CLOSED

### Tests

- missing position snapshot
- action stuck in WAITING_CONFIRMATION
- restart while close pending

### DoD

- false disappearance tidak auto-close
- startup recovery ada

### Prompt vibecode

“Build a reconciliation worker that handles missing snapshots, pending confirmations, and restart recovery. Missing from API must map to RECONCILIATION_REQUIRED, not CLOSED. Add integration tests.”

---

## Batch 9 — Management rules engine

### Tujuan

Membuat evaluator posisi yang pure dan deterministic.

### Bangun

- `managementRules.ts`
- rule precedence
- evaluation result object
- `managementPriority.ts`

### Output

- untuk 1 snapshot posisi, engine mengeluarkan tepat 1 action resmi

### Tests

- stop loss mengalahkan claim fees
- hard exit mengalahkan rebalance
- hold jika semua aman
- partial close dan rebalance tidak keluar bersamaan

### DoD

- management rules tidak memanggil IO
- mudah diuji dengan snapshot statis

### Prompt vibecode

“Implement a pure management rules engine that returns exactly one allowed action per position snapshot. Respect precedence: emergency > hard exit > maintenance > hold. Add tests for rule collisions.”

---

## Batch 10 — Screening rules + scoring engine

### Tujuan

Membangun pipeline kandidat yang deterministic.

### Bangun

- `screeningRules.ts`
- `candidateScore.ts`
- filter keras
- score breakdown
- shortlist builder

### Output

- screening menghasilkan shortlist deterministic top N

### Tests

- hard filter reject cases
- score ordering cases
- exposure conflict rejects candidate

### DoD

- AI belum dibutuhkan agar screening bisa menghasilkan shortlist

### Prompt vibecode

“Implement deterministic screening hard filters and candidate scoring with score breakdown. Output a shortlist of top N candidates. Add tests for hard rejects, scoring order, and exposure conflicts.”

---

## Batch 11 — Rebalance flow resmi

### Tujuan

Mengubah rebalance menjadi flow dua fase yang sah.

### Bangun

- `requestRebalance.ts`
- queue orchestration: close old leg -> finalize close -> redeploy new leg
- failure branches: redeploy fail, close timeout, validation fail
- rebalance journal events

### Output

- rebalance tidak bisa skip finalizer close

### Tests

- rebalance success
- close old leg timeout
- redeploy fail permanen -> `REBALANCE_ABORTED`
- old position closed but no new deploy

### DoD

- tidak ada deploy baru sebelum close lama finalized

### Prompt vibecode

“Implement rebalance as an explicit two-leg workflow: close old position, finalize close, validate capital, then redeploy. Add tests for successful rebalance and aborted rebalance paths.”

---

## Batch 12 — Portfolio risk engine

### Tujuan

Memusatkan semua guardrail global.

### Bangun

- `riskRules.ts`
- exposure calculators
- capital usage calculator
- circuit breaker state
- daily realized PnL tracker

### Output

- deploy/rebalance/close decisions divalidasi oleh risk engine

### Tests

- daily loss limit blocks new deploys
- pool exposure reject
- token exposure reject
- reserve SOL guard works

### DoD

- risk rules reusable di screening dan action execution

### Prompt vibecode

“Implement portfolio risk rules: capital usage, reserve balance, token exposure, pool exposure, daily loss limit, and circuit breaker. Add tests that block deploys while still allowing safe close/reconcile actions.”

---

## Batch 13 — Workers orchestration tanpa AI

### Tujuan

Menjalankan bot end-to-end secara deterministic.

### Bangun

- `screeningWorker.ts`
- `managementWorker.ts`
- `reportingWorker.ts`
- scheduler metadata
- manual triggers update shared timer state

### Output

- bot bisa jalan dry-run tanpa LLM

### Tests

- screening menghasilkan request deploy
- management menghasilkan request close/rebalance/claim
- manual trigger tidak bikin double-fire liar

### DoD

- worker read-only vs write-request boundary jelas

### Prompt vibecode

“Build screening, management, and reporting workers around the deterministic engine. Workers may enqueue actions but must not write directly. Keep scheduler metadata shared for cron and manual triggers.”

---

## Batch 14 — Operator interfaces: CLI dan Telegram read-first

### Tujuan

Membuat kontrol manual yang aman.

### Bangun

- status command
- positions command
- pending actions command
- manual close/deploy/rebalance request command
- alert notifications

### Output

- operator bisa melihat state dan mengirim request action

### Tests

- command parser
- invalid command rejection
- manual request creates action queue entry, not direct execution

### DoD

- Telegram/CLI tidak mem-bypass queue

### Prompt vibecode

“Implement CLI and Telegram interfaces as operator surfaces. Commands must create action requests or read state, never bypass the queue. Add tests for parsing and invalid/manual requests.”

---

## Batch 15 — AI layer (advisory dulu)

### Tujuan

Menambahkan AI tanpa membiarkannya menguasai lifecycle inti.

### Bangun

- `LlmGateway`
- AI ranking untuk shortlist screening
- AI reasoning untuk management snapshots
- strict schema output
- mode `disabled`, `advisory`, `constrained_action`

### Output

- AI hanya mengembalikan structured recommendation

### Tests

- invalid AI output fallback ke deterministic engine
- AI timeout tidak memblokir worker
- AI tidak bisa menghasilkan action di luar enum

### DoD

- bot tetap aman kalau LLM mati

### Prompt vibecode

“Add an optional LLM advisory layer that ranks shortlist candidates and explains management decisions using strict JSON schema output. The engine must ignore invalid AI output and continue deterministically.”

---

## Batch 16 — Real adapters: DLMM, swap, screening APIs

### Tujuan

Menghubungkan engine ke dunia nyata setelah core cukup stabil.

### Bangun

- implement gateway nyata untuk DLMM
- implement swap gateway
- implement screening/intel gateways
- adapter-level error mapping

### Output

- deterministic engine sekarang bicara ke service asli

### Tests

- contract tests untuk adapter responses
- error mapping tests

### DoD

- domain tidak tahu detail vendor SDK

### Prompt vibecode

ways behind the existing interfaces. Map vendor-specific errors into typed domain-safe errors. Add contract tests and mocks for network failures.”

---

## Batch 17 — Dry-run simulation harness

### Tujuan

Menguji lifecycle berkali-kali tanpa uang asli.

### Bangun

- simulation runner
- replay fixtures
- fake clock
- scenario packs

### Output

- bisa mensimulasikan banyak lifecycle secara repeatable

### Tests

- stop loss scenario
- rebalance scenario
- reconciliation after timeout
- circuit breaker scenario

### DoD

- setiap bug lifecycle bisa direpro dari fixture

### Prompt vibecode

“Build a dry-run simulation harness with fake clock and replay fixtures so lifecycle bugs can be reproduced deterministically. Include scenarios for stop loss, rebalance, timeout reconciliation, and circuit breaker.”

---

## Batch 17.1 — Lesson memory inti dan wajib-konsultasi untuk AI entry

### Tujuan

Membuat sistem pembelajaran agen seperti `lessons.js` di repo lama (`/meredian-fixed/lessons.js`), namun dibentuk ulang sesuai arsitektur V2 (domain / app / adapters, Zod, strict TS). Setiap posisi yang ditutup harus menghasilkan `PerformanceRecord` dan — jika outcome cukup bermakna — sebuah `Lesson`. Semua Lesson harus tersedia untuk `AiAdvisoryService` dengan injeksi prompt bertingkat (pinned → role → recent) sehingga AI **selalu** belajar dari pengalaman sebelum memutuskan entry (screening/deploy) dan manajemen (rebalance/close).

**Persyaratan keras:** pada mode AI apa pun selain `disabled`, setiap panggilan `rankShortlistWithAi` (entry) WAJIB memanggil `buildLessonsPrompt({ agentType: "SCREENER" })` dan menyisipkan hasilnya ke system prompt. Tidak boleh ada jalur entry yang melewati konsultasi lesson. Kalau `buildLessonsPrompt` melempar error, fallback ke deterministic engine (sama seperti fallback AI saat ini), tapi tetap **log** sebagai `ai_lesson_injection_failed` agar tidak diam-diam kehilangan konteks.

### Bangun

- **Entity + schema (domain):**
  - `src/domain/entities/PerformanceRecord.ts`
    - Zod schema `PerformanceRecordSchema` dengan field: `positionId`, `pool` (alamat), `poolName`, `baseMint`, `strategy` (enum dari `domain/types/enums.ts` — `"spot" | "curve" | "bid_ask"`), `binStep`, `binRangeLower`, `binRangeUpper`, `volatility`, `feeTvlRatio`, `organicScore`, `amountSol`, `initialValueUsd`, `finalValueUsd`, `feesEarnedUsd`, `pnlUsd`, `pnlPct`, `rangeEfficiencyPct`, `minutesHeld`, `minutesInRange`, `closeReason` (enum di `domain/types/enums.ts`: `"manual" | "stop_loss" | "take_profit" | "out_of_range" | "volume_collapse" | "timeout" | "operator"`), `deployedAt`, `closedAt`, `recordedAt`.
    - Branded types: `Percentage`, `UsdAmount` bila belum ada di `domain/types/brands.ts`, reuse.
  - `src/domain/entities/Lesson.ts`
    - `LessonOutcome` = `"good" | "poor" | "bad" | "manual" | "evolution"` (outcome `"neutral"` sengaja dibuang karena tidak menghasilkan lesson).
    - `LessonRole` = `"SCREENER" | "MANAGER" | "GENERAL"`.
    - `LessonSchema` dengan: `id` (ULID, bukan `Date.now()` — id harus stabil, monotonic, dan uji-reproducible di tes), `rule` (string 1..500), `tags` (string array, lower-cased, unik), `outcome`, `role` (nullable → default `null` = semua role), `pinned` (bool), `pnlPct` (optional), `rangeEfficiencyPct` (optional), `pool` (optional), `context` (string optional), `createdAt`.
    - Semua field snake_case dari repo lama diterjemahkan ke camelCase. Repository harus melakukan migrasi satu-arah saat load dari file lama bila perlu (lihat bagian Output).
- **Domain rule (pure, tanpa I/O):**
  - `src/domain/rules/lessonRules.ts`
    - `deriveLesson(perf: PerformanceRecord, now: string, idGen: () => string): Lesson | null`
    - Tingkat outcome: `good` (pnlPct ≥ 5), `neutral` (≥ 0), `poor` (≥ -5), `bad` (< -5). `neutral` return `null`.
    - Template rule mengikuti `derivLesson` di repo lama (AVOID/PREFER/WORKED/FAILED/volume_collapse) tapi dipecah ke beberapa fungsi kecil agar testable: `classifyOutcome`, `buildContextString`, `pickRuleTemplate`, `collectTags`.
    - Tag role otomatis: fungsi helper `inferRoleTags(perf)` menghasilkan subset dari `["oor", "efficient", "volume_collapse", "worked", "failed", perf.strategy, \`volatility\_${Math.round(perf.volatility)}\`]`.
    - Deterministik — tidak boleh memanggil `Date.now()` atau `Math.random()`; semua waktu/id masuk via parameter.
    - 100% pure → unit-testable dengan tabel skenario.
  - `src/domain/rules/lessonPromptRules.ts`
    - `ROLE_TAGS` constant (sama dengan repo lama).
    - `selectLessonsForRole({ lessons, role, caps, now }): { pinned: Lesson[]; role: Lesson[]; recent: Lesson[] }`. Pure. Bertanggung jawab atas tiering: Pinned → RoleMatched → Recent dengan `outcomePriority` dan dedup via `usedIds`.
    - `formatLessonsPrompt(sections): string` — menghasilkan blok teks siap sisip: heading `── PINNED (n) ──`, `── SCREENER (n) ──`, `── RECENT (n) ──` dengan body `[OUTCOME] [YYYY-MM-DD HH:mm] rule` dan prefix `📌 ` untuk pinned. Tanpa emoji lain.
    - Caps: `isAutoCycle` → PINNED_CAP=5, ROLE_CAP=6, RECENT_CAP=10; otherwise 10/15/35. Override via parameter `maxLessons` hanya mengubah `RECENT_CAP`.
- **Adapter persistence:**
  - `src/adapters/storage/LessonRepository.ts`
    - Interface: `list(): Promise<Lesson[]>`, `append(lesson: Lesson): Promise<void>`, `update(id, patch): Promise<void>`, `remove(id): Promise<number>`, `clear(): Promise<number>`, `replaceAll(list): Promise<void>`.
    - Implementasi `FileLessonRepository` di atas `FileStore` yang sudah ada (keyed lock per path, atomic write). File disimpan di path yang disediakan `infra/paths.ts` (tambahkan `lessonsFilePath`, default `<dataDir>/lessons.json`).
    - Schema file: `{ lessons: Lesson[], performance: PerformanceRecord[] }`. Satu file agar migrasi dari repo lama mudah dan snapshot lesson+performance selalu konsisten.
    - Validasi Zod saat load; jika file korup/invalid, lempar `LessonStoreCorruptError` — TIDAK boleh diam-diam reset seperti repo lama. Worker di level atas yang memutuskan apakah membuat backup + file kosong (di Batch 18).
  - `src/adapters/storage/PerformanceRepository.ts`
    - Pasangan dari LessonRepository tapi khusus `PerformanceRecord[]` dalam file yang sama (boleh share file store dengan `LessonRepository` via composition — mis. `LessonAndPerfFileStore` internal).
    - `append(record)`, `list({ sinceIso?, limit? })`, `summary()`, `clear()`.
- **Use case:**
  - `src/app/usecases/recordPositionPerformance.ts`
    - Input: `{ performance: PerformanceRecord; lessonRepository; performanceRepository; journalRepository; idGen; now }`.
    - Langkah:
      1. Guard suspicious unit-mix (port dari `lessons.js:61–73`, tapi sebagai pure predicate `isSuspiciousUnitMix(perf)` di `domain/rules/lessonRules.ts`).
      2. Append `PerformanceRecord` ke `performanceRepository`.
      3. `const lesson = deriveLesson(perf, now(), idGen);` — bila non-null, `lessonRepository.append(lesson)`.
      4. Emit `JournalEvent` bertipe baru `"LESSON_RECORDED"` (tambahkan ke `domain/entities/JournalEvent.ts` sebagai anggota discriminated union). Payload berisi `lessonId`, `outcome`, `pnlPct`, `pool`, `role`.
      5. Return `{ performance, lesson }`.
    - **Tidak** memanggil `evolveThresholds`, tidak memanggil pool-memory, tidak memanggil Darwin. Itu dipisah ke Batch 17.2–17.4 lewat composition di worker.
  - `src/app/services/LessonPromptService.ts`
    - `buildLessonsPrompt({ role, maxLessons? }): Promise<string | null>`
    - Memuat semua lesson via `LessonRepository.list()`, memanggil `selectLessonsForRole`, lalu `formatLessonsPrompt`. Jika list kosong → `null`.
    - Service ini stateless (tidak cache) — I/O disebar ke repository agar mudah ditest. Caching latency boleh dipertimbangkan di Batch 18, bukan di sini.
- **Hook integrasi ke lifecycle:**
  - Tambahkan opsional `LessonHook` ke `finalizeClose` usecase (pola sama dengan `PostCloseSwapHook` yang sudah ada):
    - Type: `type LessonHook = (input: { position: Position; closedAction: Action; pnlUsd: UsdAmount; ... }) => Promise<PerformanceRecord>`.
    - Bila hook non-null, `finalizeClose` memanggil hook setelah state reconcile sukses dan memforward `PerformanceRecord` ke `recordPositionPerformance` via DI (atau menginjeksi `recordPositionPerformance` langsung lewat `LessonHook`).
    - Default-nya hook = undefined → behavior lama tidak berubah.
  - Composition root di `src/index.ts`:
    - Instansiasi `FileLessonRepository`, `FilePerformanceRepository`, `LessonPromptService`, lalu teruskan ke:
      - `finalizeClose` (via `lessonHook`) — mencatat performance + lesson saat close terfinalisasi.
      - `AiAdvisoryService` — sebagai dependency `lessonPromptService`.
- **AiAdvisoryService integrasi (WAJIB):**
  - Ubah konstruktor / factory `AiAdvisoryService` agar menerima `lessonPromptService: LessonPromptService` (required, bukan optional).
  - `rankShortlistWithAi` → sebelum memanggil LLM: `const ctx = await lessonPromptService.buildLessonsPrompt({ role: "SCREENER" })`. Kalau `ctx` non-null, sisipkan ke system prompt di bawah header `### LESSONS LEARNED`.
  - `adviseManagementDecision` → sama, role `"MANAGER"`.
  - Kalau `buildLessonsPrompt` melempar, log `ai_lesson_injection_failed` dengan `err.message`, fallback ke deterministic tanpa lesson prompt — **bukan** panggil LLM tanpa lesson (karena itu bertentangan dengan prinsip "AI harus selalu belajar"). Kecuali `AiMode === "disabled"`, AI tanpa lesson tidak boleh dipakai untuk entry.
- **Operator commands:**
  - Perluas `OperatorCommandSchema` (discriminated union di `operatorCommands.ts`) dengan anggota baru:
    - `lessons_list` (args: `role?`, `pinned?`, `tag?`, `limit?`).
    - `lessons_pin` (args: `id`).
    - `lessons_unpin` (args: `id`).
    - `lessons_add` (args: `rule`, `tags[]`, `pinned?`, `role?`).
    - `lessons_remove` (args: `id`).
    - `lessons_remove_by_keyword` (args: `keyword`).
    - `lessons_clear` (confirm: `true` required).
    - `performance_summary` (no args).
    - `performance_history` (args: `hours?`, `limit?`).
  - Setiap command memanggil LessonRepository/PerformanceRepository langsung (read-only commands tidak perlu `ActionQueue` karena tidak menyentuh portfolio state). Write commands (`add`, `pin`, `remove`) tetap lewat repository saja — lesson bukan domain action.
- **Paths:** tambahkan `LESSONS_FILE` ke `src/infra/config/paths.ts`: `path.join(dataDir, "lessons.json")`. `ensureDataDir()` sudah ada.

### Output

- File `lessons.json` dipopulasikan otomatis saat posisi tertutup.
- `AiAdvisoryService` menerima blok lesson yang sama persis strukturnya dengan repo lama (Pinned/Role/Recent) untuk setiap panggilan entry maupun manajemen.
- Operator dapat melihat / pin / unpin / menambah / menghapus lesson lewat command layer (CLI + Telegram).
- Log `ai_lesson_injection_failed` muncul bila dan hanya bila pemuatan lesson gagal (sehingga bisa di-alert di Batch 18).
- Migrasi dari file `lessons.json` repo lama opsional: sediakan script sekali-pakai `scripts/migrateLegacyLessons.ts` yang membaca snake_case → mengonversi ke `LessonSchema`/`PerformanceRecordSchema` camelCase, menyimpan sidecar backup `.bak`, dan menulis hasilnya. Tidak otomatis dijalankan — operator memicunya manual.

### Tests

- `tests/unit/domain/lessonRules.test.ts`:
  - Tabel 10+ skenario `deriveLesson` (good/bad OOR, good high efficiency, bad volume collapse, neutral → null, manual, semua `closeReason`).
  - `isSuspiciousUnitMix` mengembalikan true pada record port langsung dari contoh repo lama.
  - `classifyOutcome`, `inferRoleTags` punya unit test masing-masing.
- `tests/unit/domain/lessonPromptRules.test.ts`:
  - `selectLessonsForRole` dengan fixture 50 lesson (mix pinned/role/outcome) menghasilkan Pinned → Role → Recent tanpa duplikat, dedup via id.
  - `formatLessonsPrompt` menghasilkan heading + prefix `📌` yang tepat.
  - Override `maxLessons` hanya memperbesar RECENT_CAP.
- `tests/unit/adapters/lessonRepository.test.ts`:
  - Append + list round-trip.
  - Load file korup → `LessonStoreCorruptError` (bukan reset).
  - `replaceAll` atomik (simulasi crash di tengah tidak meninggalkan file setengah tertulis — asserted via existing FileStore semantics).
- `tests/unit/usecases/recordPositionPerformance.test.ts`:
  - Record performance + lesson baik.
  - Record performance neutral → tidak ada lesson, journal tetap emit `"LESSON_RECORDED"`? **Tidak** — journal hanya emit kalau lesson lahir. Test memverifikasi behavior ini.
  - Record suspicious unit-mix → tidak ada performance dicatat, tidak ada lesson, return `{ skipped: true, reason: "suspicious_unit_mix" }`.
- `tests/integration/aiAdvisoryLessonInjection.test.ts`:
  - Fake LessonRepository dengan 3 pinned + 5 role + 10 recent → `rankShortlistWithAi` memanggil LLM dengan system prompt yang mengandung `### LESSONS LEARNED` + tiap tier.
  - LessonRepository melempar → `ai_lesson_injection_failed` logged, ranking tetap deterministic fallback, tidak panggil LLM.
  - `AiMode === "disabled"` → tidak memanggil `buildLessonsPrompt` sama sekali (hemat I/O).
- `tests/integration/finalizeCloseLessonHook.test.ts`:
  - Close position profit → `performance.jsonl` dan `lessons.json` punya entry baru, `JournalRepository` mendapat event `"LESSON_RECORDED"`, `PoolMemory` (Batch 17.3) tidak dipanggil (diverifikasi dengan spy).
- `tests/unit/operatorCommands.lessons.test.ts`:
  - Masing-masing command baru terparse Zod dengan benar dan memanggil repository method yang tepat. `lessons_clear` tanpa `confirm=true` ditolak.

### DoD

- `AiAdvisoryService` tidak bisa lagi diinisialisasi tanpa `lessonPromptService` (typecheck fail).
- Setiap close posisi menghasilkan PerformanceRecord; lesson lahir sesuai aturan.
- Operator CLI bisa `lessons list --role SCREENER`, `lessons pin <id>`, dan hasilnya terlihat di AI prompt siklus screening berikutnya.
- Tidak ada I/O di `domain/rules/lessonRules.ts` (static-check sederhana: tidak boleh import `fs`, `path`, atau adapter apa pun — tambahkan ESLint rule jika perlu).
- 100% green di CI; coverage unit lesson rules ≥ 95%.

### Prompt vibecode

“Port the lesson-memory system from `/meredian-fixed/lessons.js` into the V2 architecture: a pure `deriveLesson` rule in `domain/rules`, a `LessonRepository` + `PerformanceRepository` on top of FileStore, a `recordPositionPerformance` usecase wired into `finalizeClose` via an optional `LessonHook`, and a `LessonPromptService` that `AiAdvisoryService` MUST call on every screening and management AI request (tiered Pinned → Role → Recent, caps 5/6/10 for auto cycles, 10/15/35 otherwise). Add operator commands for list/pin/unpin/add/remove/clear. Forbid passing `AiAdvisoryService` without a `LessonPromptService`. If lesson injection fails, fall back to deterministic, log `ai_lesson_injection_failed`, never call the LLM without lessons on entry.”

---

## Batch 17.2 — Adaptive threshold evolution (evolveThresholds)

### Tujuan

Mengotomatisasi penyesuaian threshold screening (`minFeeActiveTvlRatio`, `minOrganic`) berdasarkan akumulasi performance, meniru `evolveThresholds` di repo lama — tapi dengan sumber-of-truth yang rapi (mutable runtime policy store) dan audit log lewat Journal + Lesson.

### Bangun

- **Mutable policy store:**
  - `src/adapters/config/RuntimePolicyStore.ts`
    - Interface: `loadOverrides(): Promise<PolicyOverrides>`, `applyOverrides(patch, metadata): Promise<PolicyOverrides>`, `snapshot(): Promise<{ policy: ScreeningPolicy; overrides: PolicyOverrides; lastEvolvedAt?: string; positionsAtEvolution?: number }>`.
    - File `data/policy-overrides.json`. Base policy tetap dari `UserConfig` (immutable). Overrides di-merge di atas base.
    - `ScreeningPolicy` di `domain/rules/screeningRules.ts` harus diperluas (atau dibuat mutable-friendly): field minimal `minFeeActiveTvlRatio`, `minOrganic`. Base defaults tetap di `configSchema.ts`; overrides tervalidasi Zod.
  - `src/app/services/PolicyProvider.ts`
    - Service kecil yang menggabungkan base config + overrides → `resolveScreeningPolicy()`. Ini yang dipakai oleh screening usecase, bukan `UserConfig` langsung.
    - Penting: screening usecase yang sekarang memanggil `config.screening` harus diganti ke `policyProvider.resolveScreeningPolicy()`.
- **Pure rule:**
  - `src/domain/rules/thresholdEvolutionRules.ts`
    - `evolveThresholds({ performance, currentPolicy, config }): { changes: Partial<ScreeningPolicy>; rationale: Record<string, string> } | null`.
    - Pure. Tidak menyentuh file, tidak `Date.now()`.
    - Port logika `lessons.js:215–323` apa adanya tapi lepas dari `fs`:
      - `MIN_EVOLVE_POSITIONS = 5`, `MAX_CHANGE_PER_STEP = 0.20`.
      - `minFeeActiveTvlRatio`: dua heuristic (lowest-winner dan loser-ceiling); clamp `[0.05, 10.0]`; nudge ≤ 20%.
      - `minOrganic`: gap-based; clamp `[60, 90]`; round integer.
    - Helpers `clamp`, `nudge`, `avg`, `isFiniteNum` diekspos sebagai util privat di module yang sama (atau `domain/util/math.ts` jika sudah ada).
    - Unit-testable dengan fixture performance deterministik.
- **Use case:**
  - `src/app/usecases/maybeEvolvePolicy.ts`
    - Input: `{ performanceRepository; runtimePolicyStore; lessonRepository; journalRepository; config; now; idGen }`.
    - Langkah:
      1. Load semua `PerformanceRecord`. Kalau `len % MIN_EVOLVE_POSITIONS !== 0` → return `{ skipped: true }`.
      2. Panggil `evolveThresholds({ performance, currentPolicy, config })`.
      3. Bila `changes` non-empty:
         - `runtimePolicyStore.applyOverrides(changes, { positionsAtEvolution, rationale })`.
         - Emit journal event `"POLICY_EVOLVED"` (tambahkan ke union) dengan payload `{ changes, rationale, positionsAtEvolution }`.
         - Emit lesson audit via `lessonRepository.append(...)` dengan outcome `"evolution"` + tags `["evolution", "config_change"]` + `pinned: false`.
      4. Return hasil.
  - Dipanggil oleh **worker orchestration** (Batch 13) **setelah** `recordPositionPerformance` sukses — bukan dari dalam `recordPositionPerformance`, supaya usecase close tidak memiliki side-effect policy.
- **Composition root:**
  - Instansiasi `FileRuntimePolicyStore`, `PolicyProvider`, lalu inject ke screening usecase + `maybeEvolvePolicy`. Screening usecase **tidak** boleh lagi membaca `config.screening` langsung.

### Output

- Setelah kelipatan 5 posisi ditutup, worker memanggil `maybeEvolvePolicy`. Kalau ada perubahan, file `policy-overrides.json` ter-update, screening siklus berikutnya memakai nilai baru, journal mencatat `"POLICY_EVOLVED"`, dan satu lesson evolusi tersimpan.
- Operator bisa melihat overrides via command baru `policy show` dan `policy reset` (menghapus file overrides).

### Tests

- `tests/unit/domain/thresholdEvolutionRules.test.ts`:
  - Fixture `< 5` performance → `null`.
  - Fixture 5 performance, semua winner → no change (tidak ada losers).
  - Fixture mixed → `minFeeActiveTvlRatio` naik sesuai lowest-winner rule.
  - Fixture gap organic tinggi → `minOrganic` naik, dibulatkan integer, clamp `[60, 90]`.
  - Nudge ≤ 20% (delta cap) diverifikasi pada fixture yang menuntut lompatan > 20%.
- `tests/unit/usecases/maybeEvolvePolicy.test.ts`:
  - `len % 5 !== 0` → skip.
  - Perubahan valid → store, journal, lesson semua tertulis; return `{ changes }`.
  - Perubahan empty `{}` → tidak menulis apapun, return `{ changes: {} }`.
- `tests/unit/adapters/runtimePolicyStore.test.ts`:
  - Load base + no overrides file → policy sama dengan base.
  - Apply overrides → snapshot kembalikan merge yang benar + metadata.
  - File invalid → `PolicyStoreCorruptError`.
- `tests/integration/screeningUsesEvolvedPolicy.test.ts`:
  - Setelah `maybeEvolvePolicy` menaikkan `minFeeActiveTvlRatio`, siklus screening berikutnya menolak pool yang sebelumnya lolos.

### DoD

- Screening usecase tidak pernah membaca `config.screening` langsung (grep test di CI).
- Tidak ada mutasi in-place ke objek config (berbeda dengan repo lama — V2 memakai store + provider immutable-per-call).
- `policy show` dan `policy reset` berfungsi di CLI.
- Setiap evolusi meninggalkan jejak: journal event + lesson audit.

### Prompt vibecode

“Add an adaptive threshold evolution layer: a pure `evolveThresholds` rule (port from `/meredian-fixed/lessons.js:215–323` — clamp, nudge ≤ 20%, lowest-winner + loser-ceiling heuristics), a `RuntimePolicyStore` that merges file overrides on top of base config, a `maybeEvolvePolicy` usecase called by the worker every 5 closed positions, and journal+lesson audit trails for each change. Screening must use a `PolicyProvider.resolveScreeningPolicy()` call, never read `config.screening` directly.”

---

## Batch 17.3 — Pool memory (per-pool deploy history dan cooldown)

### Tujuan

Menyediakan ingatan per-pool seperti `pool-memory.js` di repo lama: setiap alamat pool menyimpan ringkasan deploy historis (total deploy, avg PnL, win rate, last outcome, cooldown). Screening dan `AiAdvisoryService` dapat menarik ringkasan ini sebelum memutuskan entry — agar AI tahu "pool ini sudah pernah gagal 3x berturut" atau "masih cooldown 2 jam lagi".

### Bangun

- **Entity:**
  - `src/domain/entities/PoolMemory.ts`
    - Zod: `PoolMemoryEntrySchema` dengan `poolAddress`, `name`, `baseMint` (nullable), `totalDeploys`, `deploys: PoolDeploySchema[]` (maks 50 — yang lebih lama dipotong), `avgPnlPct`, `winRatePct`, `lastDeployedAt`, `lastOutcome` (`"profit" | "loss" | null`), `notes: { note: string; addedAt: string }[]`, `snapshots: PoolSnapshotSchema[]` (maks 48 → ~4 jam @ 5 menit), `cooldownUntil` (optional ISO).
    - `PoolDeploySchema`: `deployedAt`, `closedAt`, `pnlPct`, `pnlUsd`, `rangeEfficiencyPct`, `minutesHeld`, `closeReason`, `strategy`, `volatilityAtDeploy`.
    - `PoolSnapshotSchema`: `ts`, `positionId`, `pnlPct`, `pnlUsd`, `inRange`, `unclaimedFeesUsd`, `minutesOutOfRange`, `ageMinutes`.
- **Adapter:**
  - `src/adapters/storage/PoolMemoryRepository.ts`
    - Interface: `get(poolAddress): Promise<PoolMemoryEntry | null>`, `upsert(poolAddress, patcher: (cur|null) => PoolMemoryEntry): Promise<PoolMemoryEntry>`, `listAll(): Promise<PoolMemoryEntry[]>`, `addNote(poolAddress, note)`, `setCooldown(poolAddress, untilIso)`.
    - `File` impl di atas FileStore; satu file JSON `data/pool-memory.json` dengan keyed lock — path unik per pool address _tidak_ diperlukan karena file kecil dan writer tunggal.
- **Domain rule:**
  - `src/domain/rules/poolMemoryRules.ts`
    - Pure:
      - `computePoolAggregates(deploys): { totalDeploys; avgPnlPct; winRatePct; lastOutcome; lastDeployedAt }`.
      - `shouldCooldown({ closeReason, closeReasonSet }): boolean` — port dari repo lama (`close_reason === "low yield"` di lama, di V2 pakai enum `"low_yield"` bila ada; atau kriteria lain yang lebih jelas).
      - `buildPoolRecallString(entry): string | null` — port dari `recallForPool` di repo lama (lines + recent trend + last note) dengan nama field V2.
- **Use case:**
  - `src/app/usecases/recordPoolDeploy.ts`
    - Dipanggil dari worker setelah `recordPositionPerformance` sukses (composition seperti `maybeEvolvePolicy`).
    - Upsert entry, recompute aggregates, set `cooldownUntil` bila `shouldCooldown`.
    - Emit journal `"POOL_MEMORY_UPDATED"`.
  - `src/app/usecases/recordPoolSnapshot.ts`
    - Dipanggil dari management cycle untuk setiap posisi hidup: menambahkan `PoolSnapshot` (maks 48).
    - **Opt-in** — default off via config flag `poolMemory.snapshotsEnabled`. Snapshot cepat menumpuk; aktifkan saat butuh trend analysis.
- **Integrasi screening + AI:**
  - `LessonPromptService.buildLessonsPrompt` (Batch 17.1) diperluas dengan opsi `{ includePoolMemory?: { candidates: { poolAddress }[] } }`. Bila diaktifkan, service menarik `PoolMemoryEntry` untuk tiap kandidat dan menyisipkan blok `### POOL MEMORY` di bawah `### LESSONS LEARNED`.
  - `AiAdvisoryService.rankShortlistWithAi` wajib mengaktifkan opsi ini (mandatory kedua, setelah lessons): setiap pool di shortlist harus disertai ringkasan history + cooldown-nya.
  - Screening pure rule (`domain/rules/screeningRules.ts`) mendapat helper `applyCooldownFilter(candidates, poolMemoryMap, now)` yang membuang kandidat dengan `cooldownUntil > now`. Diterapkan sebelum scoring.
- **Operator commands:**
  - `pool memory <address>` → dump entry + recall string.
  - `pool note <address> <note>` → append note.
  - `pool cooldown <address> <hours>` → manual set.
  - `pool cooldown_clear <address>`.

### Output

- File `pool-memory.json` otomatis dipopulasikan setiap close.
- Screening menolak pool yang sedang cooldown.
- AI shortlist prompt berisi konteks historis per pool.

### Tests

- `tests/unit/domain/poolMemoryRules.test.ts`:
  - `computePoolAggregates` pada fixture 3/5/0 deploy.
  - `buildPoolRecallString` menghasilkan lines yang benar (deploy history + trend OOR + last note).
  - `shouldCooldown` true untuk `"low_yield"`, false untuk lainnya.
- `tests/unit/usecases/recordPoolDeploy.test.ts`:
  - Deploy pertama → entry baru dengan totalDeploys=1.
  - Deploy berulang → aggregates benar, maks 50 deploys dipertahankan.
  - Close reason low_yield → `cooldownUntil = now + 4h`.
- `tests/integration/screeningCooldownFilter.test.ts`:
  - Pool dengan `cooldownUntil` masih berlaku → tidak muncul di shortlist.
- `tests/integration/aiShortlistPoolMemory.test.ts`:
  - Prompt mengandung `### POOL MEMORY` untuk tiap kandidat.

### DoD

- Semua close menghasilkan entry pool-memory yang konsisten.
- Screening tidak pernah memilih pool dalam cooldown.
- AI shortlist selalu melihat pool-memory (wajib, sama seperti lessons).

### Prompt vibecode

“Add a per-pool deploy-history store (port `/meredian-fixed/pool-memory.js`) with a `PoolMemoryRepository`, pure aggregate rules, `recordPoolDeploy` and `recordPoolSnapshot` usecases, cooldown-based screening filter, and a mandatory `### POOL MEMORY` block injected into the AI shortlist prompt. Cooldown triggers on low-yield closes (default 4h).”

---

## Batch 17.4 — Darwinian signal weights (opsional, stretch)

### Tujuan

Mengotomatisasi tuning bobot signal pada scoring engine berdasarkan korelasi historis antara nilai signal saat entry dan outcome close — mirip `signal-weights.js` di repo lama. Memerlukan Batch 17.1 (performance records) + Batch 17.2 (runtime policy store) sudah jalan.

### Bangun

- `src/domain/entities/SignalWeights.ts` — Zod schema: `Record<signalKey, { weight: number; sampleSize: number; lastAdjustedAt: string }>`. `signalKey` ∈ set yang dipakai oleh `screeningRules.scoreCandidate` (mis. `feeTvlRatio`, `organicScore`, `narrativeBoost`, dst — daftar eksplisit di `domain/rules/screeningRules.ts`).
- `src/domain/rules/signalWeightRules.ts` — pure `recalculateWeights({ performance, currentWeights, config }): { changes: Partial<SignalWeights>; rationale }`. Algoritma:
  - Hitung korelasi antara nilai signal (dinormalkan) dan `pnlPct` per record.
  - Jika korelasi positif kuat → naikkan weight ≤ 20% per step; negatif → turunkan, clamp `[0.1, 3.0]`.
  - Minimum sampleSize per signal = 10 sebelum berani menyesuaikan.
- `src/adapters/storage/SignalWeightsStore.ts` — mirror `RuntimePolicyStore` tapi untuk weights.
- `src/app/usecases/maybeRecalibrateSignalWeights.ts` — dipanggil dari worker setelah kelipatan 10 posisi; behind config flag `darwin.enabled` (default `false`). Emit journal `"SIGNAL_WEIGHTS_RECALIBRATED"` + lesson audit.
- Scoring di `domain/rules/screeningRules.ts` membaca weights via parameter `signalWeights` (suntik dari provider). Tidak mutasi global.

### Output

- Saat `darwin.enabled = true`, bobot signal screening menyesuaikan pelan-pelan dengan performa historis. Log audit lengkap.

### Tests

- `tests/unit/domain/signalWeightRules.test.ts`: korelasi positif kuat → weight naik ≤ 20%; sample kecil → no-op; clamp jalan.
- `tests/unit/usecases/maybeRecalibrateSignalWeights.test.ts`: flag off → skip; flag on + kelipatan 10 → apply.
- `tests/integration/screeningUsesDarwinWeights.test.ts`: scoring output berubah setelah rekalibrasi.

### DoD

- Bendera default off — tidak mengganggu lifecycle inti.
- Semua perubahan weight tercatat di journal + lesson.
- Tidak ada path di screening yang membypass `signalWeights` saat flag on.

### Prompt vibecode

“Add an optional Darwinian signal-weight calibration layer (port `/meredian-fixed/signal-weights.js`) behind `config.darwin.enabled`. Pure `recalculateWeights` rule, `SignalWeightsStore`, a `maybeRecalibrateSignalWeights` usecase called every 10 closed positions, screening scorer reads weights via a provider, and journal+lesson audit for each adjustment.”

---

## Batch 18 — Hardening dan live-readiness checklist

### Tujuan

Menyiapkan supervised live testing.

### Bangun

- alert stuck action
- alert pending reconcile
- metrics summary
- redacted logs
- packaging cleanup
- startup recovery checklist

### Output

- release candidate untuk supervised live run

### Tests

- startup recovery after crash
- log redaction
- alert generation

### DoD

- regression suite inti lulus
- no secret in logs/package
- operator bisa membedakan healthy vs unsafe state

### Prompt vibecode

“Add hardening features for live-readiness: startup recovery checks, alerting for stuck actions, log redaction, metrics summaries, and packaging cleanup. Provide a supervised-live checklist.”

---

## Batch 19 — Config knobs parity & operator controls (low effort, high value)

### Tujuan

Menutup gap fitur repo lama yang high-value tetapi relatif murah diport ke V2: screening horizon/timeframe, age/ATH/profitability knobs, dual-unit risk target, mode tampilan SOL, dan panic-button operator. Batch ini sengaja diprioritaskan lebih dulu karena mayoritas berupa config schema + pure rule + operator surface.

### Bangun

- **Screening timeframe**
  - Tambah `screening.timeframe` dengan enum minimal `"5m" | "1h" | "24h"`.
  - Timeframe ini dibawa ke screening/runtime gateway request agar operator bisa memilih antara fresh/liquid pools vs aged pools tanpa restart/wiring baru.
- **Token age range**
  - Tambah `screening.minTokenAgeHours` dan `screening.maxTokenAgeHours` (opsional, batas bawah/atas).
  - Screening hard filter harus bisa menolak token terlalu muda atau terlalu tua.
- **ATH price filter**
  - Tambah `screening.athFilterPct`.
  - Semantik: candidate hanya lolos bila harga saat ini cukup jauh di bawah ATH sesuai threshold.
- **24h fee profitability floor**
  - Tambah `screening.minFeePerTvl24h`.
  - Ini complementary terhadap `minFeeActiveTvlRatio`; gunakan sebagai floor profitability 24h yang lebih mirip repo lama.
- **Daily profit target**
  - Tambah `risk.dailyProfitTargetSol`.
  - Reporting/operator alert harus bisa memberi sinyal "target harian tercapai".
- **Daily loss absolute**
  - Tambah `risk.maxDailyLossSol` sebagai representasi alternatif dari `dailyLossLimitPct`.
  - V2 harus mendukung **keduanya**; trip rule memakai OR (`pct breached` atau `absolute SOL breached`).
- **SOL display mode**
  - Tambah `reporting.solMode` (`false` default).
  - Reporting/brief summary/operator render dapat memilih fokus fiat vs SOL-native.
- **Manual circuit breaker**
  - Tambah operator command:
    - `circuit_breaker_trip`
    - `circuit_breaker_clear`
  - Command ini tidak boleh bypass queue/write boundary lain; cukup mengubah runtime guard state/policy override yang resmi.

### Output

- Operator bisa mengganti screening horizon dan risk target tanpa refactor runtime.
- Risk layer mendukung target/loss dalam SOL maupun %.
- Panic button tersedia untuk menghentikan deploy baru saat market crash.

### Tests

- screening timeframe diteruskan ke boundary/runtime request.
- token age / ATH / min fee per TVL 24h memblok candidate yang tidak sesuai.
- daily profit target memicu alert/report.
- daily loss trip OR antara `%` dan `SOL`.
- operator command `circuit_breaker_trip` / `clear` menutup/membuka deploy baru secara deterministic.

### DoD

- Semua knob baru tervalidasi di schema.
- Semua rule baru deterministic dan punya regression test.
- Tidak ada command operator yang bypass queue atau write directly ke posisi/action lifecycle.

### Prompt vibecode

“Add Batch 19 config/runtime parity features from the legacy bot: screening timeframe (5m/1h/24h), token age min/max, ATH filter, minFeePerTvl24h, dailyProfitTargetSol, maxDailyLossSol alongside existing percent loss guard, reporting.solMode, and manual circuit breaker operator commands. Keep all new behavior schema-driven, deterministic, and regression-tested.”

---

## Batch 20 — Enrichment, scheduling, and operator UX (medium effort)

### Tujuan

Menambah fitur yang meningkatkan kualitas screening, efisiensi runtime, dan UX operator: adaptive interval, momentum filter, token narrative enrichment, briefing harian, dan auto-swap setelah claim.

### Bangun

- **Adaptive screening interval**
  - Jangan hardcode WIB.
  - Tambah config seperti `screening.peakHours: [{ start, end, intervalSec }]` + timezone-aware evaluation.
  - Runtime scheduler memilih interval screening lebih rapat saat peak, lebih renggang saat sepi.
- **Volume trend direction**
  - Tambah `screening.minVolumeTrendPct`.
  - Candidate dapat ditolak bila volume trend turun melewati batas.
- **Token narrative enrichment**
  - Perluas `TokenIntelGateway` / adapter nyata untuk membawa narrative / intelligence summary dan holder-distribution context yang lebih kaya.
- **Briefing report**
  - Tambah template briefing harian di reporting worker.
  - Emoji **harus optional** via config, mis. `reporting.briefingEmoji: boolean`, agar konsisten dengan aturan implementasi V2 yang default-nya tidak emoji-heavy.
- **Auto-swap after claim**
  - Tambah `claim -> swap` orchestration resmi di atas `SwapGateway`, bukan ad-hoc.
  - Flow harus tetap queue-safe dan reconciliation-safe.

### Output

- Screening cadence lebih efisien.
- Operator mendapat morning/evening briefing yang lebih actionable.
- Claim flow bisa langsung mengurangi token risk lewat swap otomatis bila diaktifkan.

### Tests

- adaptive interval memilih slot interval sesuai config time window.
- volume trend filter memblok candidate downtrend.
- narrative enrichment masuk ke screening/advisory context.
- briefing render stabil dengan emoji on/off.
- auto-swap after claim menjaga status/action lifecycle tetap legal.

### DoD

- Adaptive interval configurable lintas timezone.
- Briefing tidak memaksa emoji.
- Auto-swap claim tidak membuat chain action liar di luar queue/finalizer.

### Prompt vibecode

“Add Batch 20 enrichment and UX features: adaptive screening intervals from configurable peak-hour windows (not hardcoded WIB), volume-trend screening filter, token narrative enrichment, optional-emoji daily briefing reports, and queue-safe auto-swap after claim.”

---

## Batch 21 — Advanced exits & compounding automation (higher effort)

### Tujuan

Menambah exit logic yang lebih adaptif dan automation compound yang dulu ada di repo lama, tetapi dengan state/lifecycle V2 yang benar.

### Bangun

- **Trailing take profit**
  - Tambah config:
    - `management.trailingTakeProfitEnabled`
    - `management.trailingTriggerPct`
    - `management.trailingDropPct`
  - Perlu state posisi tambahan seperti `peakPnlPct` atau snapshot peak value agar trailing exit deterministic.
- **Auto-compound fees**
  - Tambah orchestration `claim -> swap -> redeploy same pool` yang resmi.
  - Harus reuse action queue / idempotency / reconciliation-safe chaining, bukan shortcut langsung.

### Output

- Exit logic bisa mempertahankan profit yang sudah terbentuk tanpa hanya mengandalkan stop-loss statis.
- Fee compounding bisa dijalankan sebagai automation resmi, bukan tool manual terpisah.

### Tests

- trailing take profit aktif setelah trigger tercapai dan close saat drawdown dari peak melampaui threshold.
- peak state survive restart/reconciliation.
- auto-compound berhasil di happy path dan aman di partial failure / timeout path.

### DoD

- Tidak ada trailing logic yang bergantung pada state ephemeral saja.
- Auto-compound tidak mem-bypass queue, tidak memecah idempotency, dan aman saat crash di tengah chain.

### Prompt vibecode

“Add Batch 21 advanced exit and compounding flows: trailing take profit with persisted peak-PnL state, and queue-safe auto-compound fees (claim -> swap -> redeploy same pool) with reconciliation-safe crash handling.”

---

## Batch 22 — Screening feature enrichment untuk DLMM strategy fit

### Tujuan

Menambahkan field-field screening yang dibutuhkan untuk memilih strategi DLMM secara adaptif, bukan lagi hanya memakai strategy global dari config.

### Bangun

- `src/domain/rules/poolFeatureRules.ts`
- `src/domain/scoring/strategySuitabilityScore.ts`
- perluasan `Candidate` schema dengan:
  - `marketFeatureSnapshot`
  - `dlmmMicrostructureSnapshot`
  - `dataFreshnessSnapshot`
  - `strategySuitability`
- mapper dari adapter screening/API ke field domain baru
- validation untuk snapshot age dan missing feature

### Field screening tambahan wajib

Market/volume:

- `volume5mUsd`, `volume15mUsd`, `volume1hUsd`, `volume24hUsd`
- `fees5mUsd`, `fees15mUsd`, `fees1hUsd`, `fees24hUsd`
- `volumeTvlRatio1h`, `volumeTvlRatio24h`
- `feeTvlRatio1h`, `feeTvlRatio24h`

Price/volatility:

- `priceChange5mPct`, `priceChange15mPct`, `priceChange1hPct`, `priceChange24hPct`
- `volatility5mPct`, `volatility15mPct`, `volatility1hPct`
- `trendStrength15m`, `trendStrength1h`
- `meanReversionScore`

DLMM microstructure:

- `binStep`
- `activeBin`
- `activeBinObservedAt`
- `activeBinAgeMs`
- `activeBinDriftFromDiscovery`
- `depthNearActiveUsd`
- `depthWithin10BinsUsd`
- `depthWithin25BinsUsd`
- `liquidityImbalancePct`
- `spreadBps`
- `estimatedSlippageBpsForDefaultSize`
- `rangeStabilityScore`
- `outOfRangeRiskScore`

Freshness:

- `screeningSnapshotAt`
- `poolDetailFetchedAt`
- `tokenIntelFetchedAt`
- `chainSnapshotFetchedAt`
- `oldestRequiredSnapshotAgeMs`
- `isFreshEnoughForDeploy`

### Output

- Candidate shortlist tetap deterministic, tetapi sekarang membawa konteks strategi lengkap.
- Setiap candidate punya `strategySuitability` berisi score untuk `curve`, `spot`, dan `bid_ask`.
- Candidate dengan snapshot stale tidak eligible untuk deploy.

### Tests

- missing `activeBin` atau stale snapshot menghasilkan hard reject.
- volatility rendah + sideways memberi `curveScore` tinggi.
- volatility sedang + depth cukup memberi `spotScore` tinggi.
- volatility tinggi + mean reversion memberi `bidAskScore` tinggi.
- pump/dump satu arah menurunkan `bidAskScore` dan bisa reject.
- estimated slippage di atas limit membuat candidate tidak eligible deploy.

### DoD

- Existing screening tetap jalan tanpa AI.
- Tidak ada deploy candidate tanpa `isFreshEnoughForDeploy = true`.
- Strategy suitability deterministic bisa dijelaskan lewat `reasonCodes`.

### Prompt vibecode

“Extend Meridian V2 screening with DLMM strategy-fit features. Add marketFeatureSnapshot, dlmmMicrostructureSnapshot, dataFreshnessSnapshot, and deterministic strategySuitability scoring for curve/spot/bid_ask. Reject stale active-bin data and shallow depth. Add unit tests for low-vol curve, moderate-vol spot, mean-reverting bid_ask, and one-way pump/dump rejection.”

---

## Batch 23 — AI Strategy Reviewer dengan strict JSON schema

### Tujuan

Membuat AI bisa menganalisis shortlist pool dan merekomendasikan strategi DLMM (`curve`, `spot`, `bid_ask`, atau `none`) tanpa punya akses write langsung.

### Bangun

- `src/adapters/llm/AiStrategyReviewer.ts`
- `src/app/usecases/reviewStrategyWithAi.ts`
- schema `StrategyReviewResultSchema`
- prompt builder khusus strategy review
- timeout dan fallback deterministic
- journal event `AI_STRATEGY_REVIEWED`

### Output AI wajib

```ts
{
  poolAddress: string;
  decision: "deploy" | "watch" | "reject";
  recommendedStrategy: "curve" | "spot" | "bid_ask" | "none";
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  binsBelow: number;
  binsAbove: number;
  slippageBps: number;
  maxPositionAgeMinutes: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  reasons: string[];
  rejectIf: string[];
}
```

### Prompt policy

AI harus dipaksa mengikuti prinsip:

- capital preservation lebih penting dari APY,
- hard reject tidak boleh diabaikan,
- bid-ask hanya untuk volatile mean-reverting pool,
- curve hanya untuk low-vol sideways/stable-ish pool,
- spot untuk moderate-vol non-directional pool,
- confidence rendah harus `watch` atau `reject`, bukan `deploy`.

### Tests

- valid AI output diparse dan disimpan.
- invalid enum strategy ditolak.
- confidence rendah mengubah deploy menjadi watch/reject.
- timeout AI fallback ke deterministic strategy.
- AI tidak dipanggil untuk candidate yang gagal hard filter.
- response non-JSON tidak boleh crash worker.

### DoD

- AI strategy reviewer tidak bisa membuat action queue entry.
- Semua output AI masuk journal untuk audit.
- Bot tetap bisa jalan jika AI mati.

### Prompt vibecode

“Implement an optional AiStrategyReviewer that receives pre-filtered DLMM candidate snapshots and returns strict JSON strategy recommendations. It must recommend curve/spot/bid_ask/none plus bins, slippage, risk params, confidence, and reasons. Invalid output, timeout, or low confidence must fall back to deterministic strategy and never enqueue deploy directly.”

---

## Batch 24 — StrategyDecisionValidator dan deploy integration dry-run first

### Tujuan

Menghubungkan rekomendasi strategi AI ke deploy payload dengan validator deterministic dan mode aktivasi bertahap.

### Bangun

- `src/domain/rules/strategyDecisionRules.ts`
- `StrategyDecisionValidator`
- perluasan config:
  - `ai.strategyReviewEnabled`
  - `ai.allowAiStrategyForDeploy`
  - `ai.minAiStrategyConfidence`
  - `deploy.maxActiveBinDrift`
  - `deploy.maxBinsBelow`
  - `deploy.maxBinsAbove`
  - `deploy.maxSlippageBps`
  - `deploy.requireFreshSnapshot`
  - `deploy.strategyFallbackMode` (`config_static`, `deterministic_best`, `reject`)
- ubah `buildAutoDeployPayload()` agar bisa memakai `finalStrategyDecision`
- journal event `STRATEGY_DECISION_VALIDATED`
- dry-run report yang membandingkan:
  - config static strategy,
  - deterministic strategy,
  - AI recommended strategy,
  - final validated strategy.

### Validator rules

Tolak strategy decision jika:

- candidate score < threshold,
- AI confidence < threshold,
- `riskLevel = high`,
- strategy tidak allowlisted,
- bins melebihi limit,
- slippage melebihi limit,
- active bin drift > limit,
- snapshot stale,
- estimated slippage > limit,
- risk engine menolak exposure/capital,
- DLMM simulation gagal.

### Aktivasi bertahap

1. **recommendation_only** — AI menulis rekomendasi ke journal, deploy tetap config static.
2. **dry_run_payload** — deploy payload dry-run memakai AI strategy, tetapi tidak submit.
3. **manual_live** — operator bisa memilih rekomendasi AI untuk manual deploy kecil.
4. **guarded_auto** — auto deploy boleh memakai AI strategy hanya jika score, confidence, risk, freshness, drift, dan simulation semuanya lolos.

### Tests

- AI deploy recommendation ditolak bila score rendah.
- AI bid_ask ditolak bila volatility tinggi tetapi trend satu arah.
- AI curve ditolak bila volatility terlalu tinggi.
- binsAbove/binsBelow clamp atau reject sesuai policy.
- `strategyFallbackMode = reject` menolak jika AI invalid.
- dry-run report memuat tiga versi strategi.
- guarded auto tidak submit jika simulation gagal.

### DoD

- Tidak ada path `AI says deploy -> submit` langsung.
- Deploy payload selalu berasal dari `finalStrategyDecision` yang sudah divalidasi.
- Mode default tetap aman: `strategyReviewEnabled=false` atau `recommendation_only`.

### Prompt vibecode

“Add StrategyDecisionValidator and integrate AI strategy decisions into auto-deploy in dry-run-first mode. Add config gates for min confidence, max active-bin drift, max bins, max slippage, and fallback behavior. Deploy must only use a finalStrategyDecision after deterministic validation and simulation; never submit directly from AI output.”

---

## Batch 25 — AI Rebalance Planner dan guarded same-pool reposition

### Tujuan

Meningkatkan rebalance dari rule sederhana menjadi flow terkontrol:

`rules detect trigger -> AI memilih action/range -> deterministic validator -> simulation -> queue execute`

AI tidak boleh bebas melakukan rebalance kapan saja. AI hanya dipanggil ketika rule deterministic mendeteksi trigger yang layak dievaluasi, dan hasil AI tetap bisa ditolak oleh validator, risk engine, active-bin drift check, dan simulation.

### Action taxonomy

Bedakan empat hasil keputusan maintenance:

- `HOLD`: tetap posisi sekarang.
- `CLAIM_ONLY`: claim fee saja, tidak mengubah range.
- `REBALANCE_SAME_POOL`: close/remove liquidity lalu redeploy di pool yang sama dengan strategy/range baru.
- `EXIT`: close posisi dan tidak redeploy karena pool/token tidak lagi sehat.

Rule penting:

- Jika pool masih sehat tetapi posisi out-of-range/near-edge, boleh evaluasi `REBALANCE_SAME_POOL`.
- Jika pool/token memburuk, jangan rebalance; pilih `EXIT`.
- Jika fee cukup tetapi range masih sehat, pilih `CLAIM_ONLY`.

### Trigger deterministic sebelum AI

AI rebalance planner hanya dipanggil jika minimal satu trigger aktif:

1. **Out-of-range duration**
   - `activeBin < lowerBin` atau `activeBin > upperBin`
   - tidak langsung pada 1 tick; tunggu `maxOutOfRangeMinutes`.

2. **Near-edge**
   - `rangeWidth = upperBin - lowerBin`
   - `edgeDistancePct = min(activeBin - lowerBin, upperBin - activeBin) / rangeWidth`
   - trigger jika `edgeDistancePct < rebalanceEdgeThresholdPct` dan posisi lebih tua dari `minPositionAgeMinutesBeforeRebalance`.

3. **Fee decay**
   - `feeVelocity15m = feesEarned15m / positionValue`
   - `feeVelocity60m = feesEarned60m / positionValue`
   - trigger jika velocity 15m jatuh drastis, misalnya `< 30%` dari 60m, dan pool masih cukup sehat.

4. **Risk change**
   - TVL drop besar
   - volume collapse
   - token risk berubah
   - price dump satu arah
   - holder concentration naik
   - depth dekat active bin menipis
   - active bin bergerak terlalu cepat

Jika trigger risk high aktif, planner harus cenderung `EXIT`, bukan `REBALANCE_SAME_POOL`.

### Snapshot yang dikirim ke AI

AI harus menerima snapshot terstruktur, bukan hanya pool address:

- `position`:
  - `positionId`
  - `poolAddress`
  - `strategy`
  - `lowerBin`
  - `upperBin`
  - `activeBinAtEntry`
  - `currentActiveBin`
  - `binStep`
  - `ageMinutes`
  - `outOfRangeMinutes`
  - `positionValueUsd`
  - `unclaimedFeesUsd`
  - `pnlPct`
  - `rebalanceCount`
  - `partialCloseCount`
- `pool`:
  - `tvlUsd`
  - `volume5mUsd`
  - `volume15mUsd`
  - `volume1hUsd`
  - `volume24hUsd`
  - `fees15mUsd`
  - `fees1hUsd`
  - `feeTvlRatio24h`
  - `liquidityDepthNearActive`
  - `priceChange5mPct`
  - `priceChange15mPct`
  - `priceChange1hPct`
  - `volatility15m`
  - `trendDirection`
  - `trendStrength`
  - `meanReversionSignal`
- `walletRisk`:
  - `dailyLossRemainingSol`
  - `openPositions`
  - `maxOpenPositions`
  - `maxRebalancesPerPosition`
  - `maxPositionSol`

### Strict AI output schema

AI output harus strict JSON:

```json
{
  "action": "hold|claim_only|rebalance_same_pool|exit",
  "confidence": 0.82,
  "riskLevel": "low|medium|high",
  "reason": ["..."],
  "rebalancePlan": {
    "strategy": "spot|curve|bid_ask",
    "binsBelow": 25,
    "binsAbove": 35,
    "slippageBps": 100,
    "maxPositionAgeMinutes": 30,
    "stopLossPct": 1.0,
    "takeProfitPct": 1.8,
    "trailingStopPct": 0.5
  },
  "rejectIf": ["activeBinDrift > 3 before submit", "simulation fails"]
}
```

Jika `action !== "rebalance_same_pool"`, `rebalancePlan` harus `null`.

### AI rebalance policy

Prompt AI harus mengandung aturan:

- Prioritaskan capital preservation daripada fee chasing.
- Jangan rekomendasikan rebalance jika pool risk high; pilih exit.
- Jangan rekomendasikan `bid_ask` kecuali volume tinggi, depth cukup, dan volatility mean-reverting.
- Gunakan `curve` hanya untuk volatility rendah dan harga kemungkinan tetap dekat active bin.
- Gunakan `spot` untuk volatility sedang atau kondisi sehat tetapi arah belum pasti.
- Jika confidence `< minAiRebalanceConfidence`, action harus `hold` atau `exit`.
- Jika posisi out-of-range tetapi pool metric tidak sehat, action harus `exit`.
- Jika near-edge tetapi belum out-of-range, prefer conservative rebalance atau hold.
- Tidak boleh output teks di luar JSON.

### Validator rules

Tambah `rebalanceDecisionValidator` yang menolak output AI jika:

- confidence < `minAiRebalanceConfidence`
- `riskLevel = high` dan action bukan `exit`
- `rebalanceCount >= maxRebalancesPerPosition`
- posisi terlalu muda (`minPositionAgeMinutesBeforeRebalance`)
- masih dalam `rebalanceCooldownMinutes`
- expected improvement tidak menutup estimated close cost + redeploy cost + safety margin
- action `rebalance_same_pool` tetapi:
  - `rebalancePlan` null
  - strategy tidak allowlisted
  - binsBelow > `maxRebalanceBinsBelow`
  - binsAbove > `maxRebalanceBinsAbove`
  - slippageBps > `maxRebalanceSlippageBps`
  - pool TVL < minimum policy
  - depth dekat active bin shallow
  - fresh active bin tidak tersedia
  - active-bin drift > `maxActiveBinDrift`
  - simulation close/redeploy gagal

Validator wajib menghasilkan structured reason/risk flags dan journal event.

### Fresh active-bin rebuild

Jika action final `REBALANCE_SAME_POOL`, bot tidak boleh memakai active bin lama dari prompt AI sebagai range final.

Flow wajib:

1. Ambil fresh active bin tepat sebelum submit.
2. `newLowerBin = freshActiveBin - aiPlan.binsBelow`
3. `newUpperBin = freshActiveBin + aiPlan.binsAbove`
4. Tolak jika `abs(freshActiveBin - aiSnapshotActiveBin) > maxActiveBinDrift`.

### Simulation before execute

Untuk safety:

1. simulate close/remove liquidity
2. simulate redeploy
3. jika redeploy simulation gagal, jangan close posisi lama kecuali action final adalah `EXIT`
4. jika kedua simulation lolos, baru queue/execute close old leg lalu redeploy leg resmi lewat flow rebalance yang sudah ada

Semua write tetap lewat action queue dan lifecycle `REBALANCE` resmi; tidak boleh ada direct write dari AI planner.

### Config baru

Tambahkan ke `management`:

```json
{
  "rebalanceEnabled": true,
  "aiRebalanceEnabled": true,
  "aiRebalanceMode": "advisory",
  "minAiRebalanceConfidence": 0.78,
  "minPositionAgeMinutesBeforeRebalance": 8,
  "rebalanceCooldownMinutes": 20,
  "maxOutOfRangeMinutes": 5,
  "rebalanceEdgeThresholdPct": 0.1,
  "maxRebalanceBinsBelow": 90,
  "maxRebalanceBinsAbove": 90,
  "maxRebalanceSlippageBps": 150,
  "requireFreshActiveBin": true,
  "maxActiveBinDrift": 3,
  "requireRebalanceSimulation": true,
  "exitInsteadOfRebalanceWhenRiskHigh": true
}
```

Mode aktivasi:

1. `aiRebalanceMode = "advisory"`: AI decision hanya journal, execution tetap deterministic.
2. `aiRebalanceMode = "dry_run"`: payload rebalance AI dibangun dan divalidasi, tetapi tidak submit.
3. `aiRebalanceMode = "constrained_action"`: AI boleh memilih `claim_only`, `rebalance_same_pool`, atau `exit`, tetapi hanya setelah validator dan simulation lolos.

Untuk awal live disarankan:

```json
{
  "rebalanceEnabled": false,
  "aiRebalanceMode": "advisory"
}
```

Setelah deploy/claim/close/reconcile terbukti aman:

```json
{
  "rebalanceEnabled": true,
  "aiRebalanceMode": "dry_run"
}
```

Baru terakhir:

```json
{
  "rebalanceEnabled": true,
  "aiRebalanceMode": "constrained_action"
}
```

### Build

- `src/domain/entities/RebalanceDecision.ts`
- `src/domain/rules/rebalanceDecisionRules.ts`
- `src/app/services/AiRebalancePlanner.ts`
- `src/app/usecases/reviewRebalanceWithAi.ts`
- integration ke `runManagementCycle()`
- journal event:
  - `AI_REBALANCE_REVIEWED`
  - `REBALANCE_DECISION_VALIDATED`
  - `REBALANCE_SIMULATION_FAILED`
- config schema + examples

### Tests

- out-of-range duration memicu review, 1 tick belum memicu.
- near-edge memicu review hanya setelah min age.
- risk high menghasilkan `EXIT`, bukan rebalance.
- low confidence menghasilkan hold/exit dan tidak queue rebalance.
- invalid strategy/bins/slippage ditolak validator.
- max rebalance count dan cooldown memblok.
- fresh active-bin drift memblok.
- redeploy simulation gagal tidak menutup posisi lama.
- claim-only menghasilkan `CLAIM_FEES`, bukan rebalance.
- constrained_action tetap lewat queue dan tidak direct write.

### DoD

- AI tidak punya path direct write.
- AI hanya dipanggil setelah trigger deterministic.
- `REBALANCE_SAME_POOL` selalu memakai fresh active bin.
- Simulation close dan redeploy wajib sebelum live execute.
- Risk high tidak boleh menjadi rebalance.
- Churn dicegah oleh max count, cooldown, min age, dan expected improvement guard.
- Mode default aman (`aiRebalanceMode="advisory"` atau `rebalanceEnabled=false`).

### Prompt vibecode

“Add an AI Rebalance Planner that only runs after deterministic rebalance triggers. It must return strict JSON with action hold/claim_only/rebalance_same_pool/exit and an optional rebalance plan. Add a deterministic validator with confidence, risk, bins, slippage, max rebalance count, cooldown, active-bin drift, and simulation gates. Integrate with existing REBALANCE queue flow without any direct AI write path.”

---

## Batch 26 — Live auto-learning wiring, lesson enforcement, dan performance feedback loop

### Tujuan

Menutup gap antara lesson system yang sudah ada dengan runtime live yang benar-benar belajar otomatis.

Batch ini memastikan setiap posisi yang selesai ditutup, baik karena manual close, stop loss, take profit, rebalance old leg, out-of-range, atau exit AI constrained, menghasilkan:

`PerformanceRecord -> optional Lesson -> PoolMemory update -> optional Policy/Darwin feedback -> journal audit -> dipakai lagi oleh AI di screening/management berikutnya`

Batch ini bukan menambah AI write privilege. AI tetap hanya membaca lesson dan pool memory sebagai konteks. Semua write trading tetap lewat queue, state machine, dan reconciliation sesuai prinsip V2.

### Problem yang ditutup

Lesson system bisa saja sudah ada, tetapi belum tentu:

- `finalizeClose()` live benar-benar memanggil `lessonHook`.
- Reconcile close/rebalance mengirim data PnL final ke performance repository.
- `AiAdvisoryService` wajib inject lessons sebelum rank shortlist.
- AI tidak dipanggil kalau lesson loading gagal.
- PoolMemory otomatis update setelah close.
- Operator bisa audit lesson/performance dari command.

Tanpa Batch 26, robot terlihat punya "lesson", tetapi learning loop bisa pasif atau hanya manual.

### Build

#### 1. Wire lesson hook ke semua close finalizer path

Pastikan `finalizeClose()` menerima dan menjalankan:

```ts
lessonHook?: LessonHook
```

Hook wajib dipanggil hanya setelah:

- close confirmed
- accounting finalized
- position status aman untuk `CLOSED` / `CLOSE_CONFIRMED`
- realized PnL sudah tersedia

Jalur yang wajib memanggil hook:

- normal close
- manual close
- stop loss close
- take profit close
- out-of-range close
- rebalance old leg close
- AI exit close

Jalur yang tidak boleh record lesson:

- close timeout
- close failed
- close submitted tapi belum reconciled
- position hilang dari snapshot tapi belum confirmed closed

#### 2. Buat createPerformanceLessonHook

Tambahkan factory di application layer:

`src/app/services/createPerformanceLessonHook.ts`

Interface:

```ts
export function createPerformanceLessonHook(input: {
  performanceRepository: PerformanceRepository;
  lessonRepository: LessonRepository;
  poolMemoryRepository?: PoolMemoryRepository;
  journalRepository: JournalRepository;
  runtimePolicyStore?: RuntimePolicyStore;
  signalWeightsStore?: SignalWeightsStore;
  config: AppConfig;
  now: () => string;
  idGen: () => string;
}): LessonHook;
```

Tugas hook:

1. Build `PerformanceRecord` dari closed position + closed action.
2. Guard suspicious unit mix.
3. Append performance record.
4. Derive lesson jika outcome meaningful.
5. Append lesson jika non-null.
6. Update pool memory jika repository tersedia.
7. Panggil `maybeEvolvePolicy` jika enabled / eligible.
8. Panggil `maybeRecalibrateSignalWeights` jika `darwin.enabled=true`.
9. Emit journal events.

Policy evolution dan Darwin boleh tetap optional, tetapi hook harus menyediakan composition point.

#### 3. Standardisasi PerformanceRecord builder

Tambahkan pure builder:

`src/domain/rules/performanceRecordRules.ts`

Fungsi:

```ts
buildPerformanceRecordFromClosedPosition(input: {
  position: Position;
  closedAction: Action;
  closeReason: CloseReason;
  finalValueUsd: number;
  feesEarnedUsd: number;
  pnlUsd: number;
  pnlPct: number;
  minutesHeld: number;
  minutesInRange?: number;
  recordedAt: string;
}): PerformanceRecordBuildResult
```

`PerformanceRecordBuildResult` harus bisa mengembalikan record sukses atau structured skipped reason:

```ts
type PerformanceRecordBuildResult =
  | { skipped: false; record: PerformanceRecord }
  | {
      skipped: true;
      reason:
        | "missing_final_accounting"
        | "invalid_cost_basis"
        | "suspicious_unit_mix";
    };
```

Rule penting:

- `initialValueUsd` tidak boleh 0 kalau deploy amount ada.
- `finalValueUsd` harus berasal dari finalized accounting, bukan estimate mentah.
- `pnlPct` harus dihitung dari cost basis final.
- `rangeEfficiencyPct` clamp `0..100`.
- `minutesHeld` minimal 0.
- `strategy` wajib valid: `spot` / `curve` / `bid_ask`.
- Kalau data tidak cukup, jangan bikin record palsu; return structured skipped reason.

#### 4. Enforce lesson injection di AI entry

Di `AiAdvisoryService.rankShortlistWithAi()`:

- AI mode disabled -> tidak load lesson.
- AI mode advisory/constrained -> wajib load lesson.
- Lesson load sukses -> panggil LLM dengan `### LESSONS LEARNED`.
- Lesson load gagal -> fallback deterministic, jangan panggil LLM.

Event wajib:

- `AI_LESSON_INJECTION_FAILED`
- `AI_SHORTLIST_RANKING_SKIPPED_NO_LESSONS`

Jika lesson list kosong tetapi repository sehat, boleh panggil LLM dengan header:

```md
### LESSONS LEARNED

No historical lessons recorded yet.
```

Yang tidak boleh adalah repository error lalu LLM tetap dipanggil tanpa konteks lesson.

#### 5. Enforce lesson injection di AI management/rebalance

Untuk management advisory:

```ts
buildLessonsPrompt({ role: "MANAGER" });
```

Untuk rebalance planner:

```ts
buildLessonsPrompt({ role: "MANAGER" });
```

Kalau ada AI rebalance planner dari Batch 25, prompt wajib membawa:

- `### LESSONS LEARNED`
- `### POOL MEMORY`
- `### POSITION PERFORMANCE CONTEXT`

Kalau lesson load error dan `aiRebalanceMode` adalah `advisory`, `dry_run`, atau `constrained_action`:

- fallback deterministic management
- jangan panggil LLM tanpa lesson

#### 6. Pool memory wajib update setelah performance record

Setelah performance record sukses:

```ts
recordPoolDeploy(performance);
```

Update:

- `totalDeploys`
- `avgPnlPct`
- `winRatePct`
- `lastOutcome`
- `lastDeployedAt`
- `cooldownUntil` jika closeReason `low_yield`, repeated loss, atau severe OOR
- recent deploy history max 50

Screening harus membaca pool memory untuk:

- cooldown hard filter
- AI prompt recall
- duplicate bad pool warning

#### 7. Backfill tool untuk posisi lama

Tambahkan script manual:

`scripts/backfillPerformanceLessons.ts`

Input:

- `positions.json`
- `actions.json`
- `journal.jsonl`

Output:

- dry-run summary
- records to create
- lessons to create
- pool memory updates
- warnings

Default harus dry-run:

```bash
npm run backfill:lessons -- --dry-run
```

Apply harus eksplisit:

```bash
npm run backfill:lessons -- --apply
```

Script tidak boleh membuat trading action.

#### 8. Operator commands

Tambahkan atau pastikan command:

- `lessons list`
- `lessons list --role SCREENER`
- `lessons list --role MANAGER`
- `lessons add`
- `lessons pin`
- `lessons unpin`
- `lessons remove`
- `lessons clear --confirm`
- `performance summary`
- `performance history`
- `pool memory <poolAddress>`
- `pool cooldown <poolAddress> <hours>`
- `pool cooldown_clear <poolAddress>`

Read command tidak perlu action queue karena tidak menyentuh chain/position lifecycle.

Write command lesson/pool-memory boleh langsung repository, tetapi wajib journal:

- `LESSON_MANUAL_ADDED`
- `LESSON_PINNED`
- `LESSON_UNPINNED`
- `LESSON_REMOVED`
- `POOL_MEMORY_NOTE_ADDED`
- `POOL_MEMORY_COOLDOWN_SET`

### Output

Setelah Batch 26 selesai:

1. Setiap finalized close menghasilkan `PerformanceRecord` atau skipped reason yang jelas.
2. Lesson otomatis lahir untuk outcome good/poor/bad.
3. PoolMemory otomatis update setelah posisi closed.
4. AI shortlist ranking wajib membaca Lessons + PoolMemory.
5. AI management/rebalance wajib membaca Lessons.
6. Jika lesson repository error, AI tidak dipanggil dan sistem fallback deterministic.
7. Operator bisa audit lesson/performance/pool memory.
8. Backfill tersedia untuk data posisi lama.

### Tests

#### Unit tests

`tests/unit/domain/performanceRecordRules.test.ts`

Cover:

- build record dari close profit
- build record dari close loss
- reject missing final accounting
- reject `initialValueUsd = 0` dengan deploy amount > 0
- rangeEfficiency clamp `0..100`
- minutesHeld tidak negatif

`tests/unit/app/createPerformanceLessonHook.test.ts`

Cover:

- profit close -> performance + good lesson + journal
- neutral close -> performance only, no lesson
- bad close -> performance + bad lesson
- suspicious unit mix -> skipped, no performance, no lesson
- pool memory called after performance success
- policy evolution called only on eligible count
- darwin skipped when config disabled

#### Integration tests

`tests/integration/finalizeCloseAutoLearning.test.ts`

Cover:

- normal close finalized -> `PerformanceRecord` created
- manual close finalized -> `PerformanceRecord` created
- rebalance old leg finalized -> `PerformanceRecord` created
- close timeout -> no `PerformanceRecord`
- missing snapshot reconcile -> no fake lesson before confirmed close

`tests/integration/aiLessonEnforcement.test.ts`

Cover:

- `rankShortlistWithAi` includes `### LESSONS LEARNED`
- `rankShortlistWithAi` includes `### POOL MEMORY`
- lesson repo throws -> deterministic fallback, LLM not called
- AI disabled -> lesson repo not called
- management AI includes MANAGER lessons
- rebalance AI includes MANAGER lessons

`tests/integration/poolMemoryLearningLoop.test.ts`

Cover:

- closed bad pool -> cooldown set
- screening excludes cooldown pool
- AI prompt contains pool history
- manual cooldown clear makes pool eligible again

#### Regression tests wajib

1. Close finalized creates exactly one performance record.
2. Duplicate reconciliation does not duplicate lesson.
3. Restart after close confirmation does not double-record performance.
4. Lesson repository corrupt blocks LLM call but does not block deterministic screening.
5. Rebalance old leg close records old leg outcome once.
6. Failed redeploy does not rewrite old close performance.
7. Operator lesson add/pin appears in next AI prompt.
8. Backfill dry-run does not mutate files.

### DoD

- Tidak ada close finalized yang silent tanpa performance record atau skipped reason.
- Tidak ada AI entry call tanpa `LessonPromptService` saat AI mode aktif.
- Tidak ada LLM call jika lesson injection error.
- `PerformanceRecord` tidak dibuat sebelum close accounting finalized.
- Lesson dan PoolMemory tidak double-record saat reconciliation jalan ulang.
- Operator bisa melihat lesson baru setelah close posisi.
- Journal punya audit event untuk lesson/performance/pool memory.
- Backfill script default dry-run dan aman.
- Semua test batch hijau.

### Jangan dikerjakan di Batch 26

- Jangan tambah strategi AI baru.
- Jangan ubah rules deploy/rebalance utama kecuali untuk membaca lessons.
- Jangan beri AI write privilege tambahan.
- Jangan auto-mutate `user-config.json`.
- Jangan backfill otomatis saat startup.
- Jangan reset `lessons.json` jika corrupt; buat error + alert.

### Prompt vibecode

Add Batch 26 live auto-learning wiring. Ensure every finalized close path creates a PerformanceRecord or a structured skipped reason, derives a Lesson when outcome is meaningful, updates PoolMemory, emits journal events, and never double-records during reconciliation retries or restart recovery. Wire LessonPromptService as mandatory context for AiAdvisoryService shortlist ranking, management advisory, and AI rebalance planning. If lesson loading fails, log AI_LESSON_INJECTION_FAILED and fallback deterministic without calling the LLM. Add operator commands for lessons/performance/pool memory and a dry-run-first backfill script for historical closed positions. Keep all trading writes behind the existing action queue; this batch must not add any AI direct write path.

---

## Batch 27 — Meteora rate-budgeted enrichment dan fresh-only deploy gate

### Tujuan

Mengurangi `HTTP 429` dari Meteora/Cloudflare dengan mengubah pipeline screening agar **tidak melakukan detail enrichment ke banyak pool**, serta memastikan deploy hanya boleh memakai data yang fresh, lengkap, dan tervalidasi.

Batch ini **bukan** menambahkan stale cache market data untuk deploy. Fokusnya adalah mengurangi jumlah request dari sumbernya:

1. `getCandidateDetails()` hanya dipanggil untuk kandidat terbaik.
2. Semua detail request melewati rate limiter.
3. Jika rate limit terjadi, sistem stop enrichment sementara.
4. Candidate tanpa fresh detail tidak boleh auto-deploy.
5. Dry-run dan prod punya request budget yang eksplisit, terukur, dan bisa diaudit.

### Problem yang ditutup

Screening saat ini bisa sukses mengambil candidate list, tetapi detail enrichment per pool bisa terkena:

```txt
MeteoraPoolDiscoveryScreeningGateway HTTP 429
candidate detail enrichment failed; continuing with gateway candidate snapshot
```

Artinya:

- `listCandidates` masih bisa berjalan.
- Yang terkena limit adalah `getCandidateDetails(poolAddress)`.
- Masalahnya bukan wallet, RPC, OpenRouter, atau action queue.
- Masalahnya adalah pola request detail Meteora yang terlalu banyak atau terlalu rapat.

### Keputusan produk

#### 1. Tidak memakai stale cache untuk deploy-critical data

Data berikut **tidak boleh dipakai dari stale cache** untuk deploy:

- `activeBin`
- `activeBinObservedAt`
- `activeBinAgeMs`
- `activeBinDriftFromDiscovery`
- `depthNearActiveUsd`
- `depthWithin10BinsUsd`
- `depthWithin25BinsUsd`
- `estimatedSlippageBpsForDefaultSize`
- `priceChange5mPct`
- `priceChange15mPct`
- `volatility5mPct`
- `volatility15mPct`
- `dataFreshnessSnapshot`

Jika data ini tidak fresh, candidate boleh muncul sebagai `WATCH` / report-only, tetapi **tidak boleh** menjadi `DEPLOY` atau `GUARDED_AUTO_DEPLOY`.

#### 2. Cache yang boleh hanya static metadata atau negative cooldown

Static metadata boleh di-cache karena tidak sensitif terhadap perubahan market cepat:

- pool address
- token mint
- symbol pair
- bin step bila stabil dari discovery source
- static token metadata

Negative cooldown juga boleh, karena ini bukan memakai data market lama. Negative cooldown hanya mengingat bahwa endpoint/pool baru saja terkena 429 atau error, sehingga bot tidak mengulang request yang sama dalam waktu dekat.

Contoh:

```txt
pool ABC detail request kena 429
→ jangan hit detail ABC lagi selama 15 menit
→ jangan lanjut spam endpoint detail dalam cycle yang sama
```

#### 3. Detail enrichment hanya top N

Default prod awal:

```json
{
  "screening": {
    "detailEnrichmentTopN": 5
  }
}
```

Flow wajib:

```txt
listCandidates
  -> hard filter dari snapshot list
  -> coarse deterministic scoring
  -> sort by score
  -> ambil top N
  -> baru getCandidateDetails untuk top N saja
```

Tidak boleh melakukan detail enrichment untuk semua candidate.

#### 4. Rate limiter global untuk Meteora detail API

Semua panggilan `getCandidateDetails()` harus melewati rate limiter global khusus endpoint detail Meteora.

Policy awal:

```txt
1 request detail setiap 3–5 detik
maks 5 detail request per screening cycle
maks 20 detail request per 15 menit
jika 429 muncul, cooldown endpoint 10–20 menit
```

Jika 429 muncul:

```txt
set cooldown endpoint
stop enrichment cycle saat itu
jangan retry pool lain di endpoint yang sama
candidate yang belum enriched menjadi WATCH/report-only
```

#### 5. Fail closed untuk deploy

Candidate tanpa fresh detail:

```txt
boleh WATCH
boleh masuk report
boleh dikirim ke operator sebagai observasi
boleh masuk AI advisory sebagai non-deployable context
TIDAK boleh auto deploy
TIDAK boleh guarded auto deploy
```

### Config baru

Tambahkan ke `user-config.json`:

```json
{
  "screening": {
    "detailEnrichmentTopN": 5,
    "detailRequestIntervalMs": 4000,
    "maxDetailRequestsPerCycle": 5,
    "maxDetailRequestsPerWindow": 20,
    "detailRequestWindowMs": 900000,
    "detailCooldownAfter429Ms": 900000,
    "requireDetailForDeploy": true,
    "allowSnapshotOnlyWatch": true
  }
}
```

Untuk dry-run lokal yang lebih santai:

```json
{
  "screening": {
    "detailEnrichmentTopN": 3,
    "detailRequestIntervalMs": 5000,
    "maxDetailRequestsPerCycle": 3,
    "maxDetailRequestsPerWindow": 10,
    "detailRequestWindowMs": 900000,
    "detailCooldownAfter429Ms": 1200000,
    "requireDetailForDeploy": true,
    "allowSnapshotOnlyWatch": true
  }
}
```

### Build

#### 1. Domain rule: enrichment budget planning

File:

```txt
src/domain/rules/enrichmentBudgetRules.ts
```

Fungsi pure:

```ts
export type EnrichmentSkipReason =
  | "outside_top_n"
  | "cycle_budget_exhausted"
  | "endpoint_in_cooldown";

export function buildEnrichmentPlan(input: {
  candidates: Candidate[];
  topN: number;
  maxDetailRequestsPerCycle: number;
  now: string;
  endpointCooldownUntil?: string | null;
}): {
  selectedForDetail: Candidate[];
  skipped: {
    candidateId: string;
    poolAddress: string;
    reason: EnrichmentSkipReason;
  }[];
};
```

Rules:

- Sort candidate berdasarkan deterministic coarse score.
- Pilih maksimal `topN`.
- Tidak boleh melebihi `maxDetailRequestsPerCycle`.
- Jika endpoint cooldown aktif, pilih 0 candidate.
- Semua candidate yang tidak dipilih harus punya skipped reason yang eksplisit.
- Fungsi harus pure, tanpa I/O dan tanpa `Date.now()`.

#### 2. Service: Meteora detail rate limiter

File:

```txt
src/app/services/MeteoraDetailRateLimiter.ts
```

Tugas:

- Menjaga jarak antar request detail.
- Menghitung request per rolling window.
- Menolak request jika budget window habis.
- Membuka cooldown jika 429 terjadi.
- Memberi `waitMs` agar caller bisa menunggu sebelum request berikutnya.

Type output:

```ts
export type DetailRateLimitDecision =
  | {
      allowed: true;
      waitMs: number;
    }
  | {
      allowed: false;
      reason: "window_budget_exhausted" | "endpoint_cooldown_active";
      retryAfterMs: number;
    };
```

Interface:

```ts
export interface MeteoraDetailRateLimiter {
  beforeRequest(now: string): DetailRateLimitDecision;
  recordSuccess(now: string): void;
  recordRateLimited(input: { now: string; retryAfterMs?: number }): void;
  getCooldownUntil(): string | null;
  snapshot(): {
    requestCountInWindow: number;
    maxDetailRequestsPerWindow: number;
    cooldownUntil: string | null;
    lastRequestAt: string | null;
  };
}
```

#### 3. Adapter error mapping untuk HTTP 429

File:

```txt
src/adapters/screening/MeteoraPoolDiscoveryScreeningGateway.ts
```

Map HTTP 429 menjadi typed error:

```ts
export class MeteoraRateLimitedError extends Error {
  readonly status = 429;
  readonly endpoint: "candidate_detail";
  readonly poolAddress?: string;
  readonly retryAfterMs?: number;
  readonly responseKind: "cloudflare_html" | "json" | "unknown";
}
```

Rules:

- Body HTML Cloudflare harus dikenali sebagai `responseKind = "cloudflare_html"`.
- 429 tidak boleh dianggap fatal untuk seluruh runtime.
- 429 harus memicu cooldown di rate limiter.
- Error selain 429 tetap mengikuti adapter error mapping yang ada.

#### 4. Screening cycle integration

File utama:

```txt
src/app/usecases/runScreeningCycle.ts
```

Flow baru:

```txt
1. listCandidates
2. hard filter dasar dari discovery snapshot
3. coarse deterministic scoring
4. buildEnrichmentPlan()
5. enrich hanya selectedForDetail
6. setiap detail request melewati MeteoraDetailRateLimiter
7. jika rate limiter meminta wait, tunggu sesuai waitMs
8. jika 429:
   - log/journal METEORA_DETAIL_RATE_LIMITED
   - recordRateLimited()
   - stop remaining detail enrichment untuk cycle ini
9. candidate tanpa detail diberi decision WATCH/SKIPPED_DETAIL
10. deploy eligibility harus mengecek requireDetailForDeploy
```

Larangan:

- Jangan detail-enrich semua candidate.
- Jangan retry semua pool setelah 429.
- Jangan lanjut memukul endpoint detail kalau cooldown aktif.
- Jangan auto-deploy candidate snapshot-only.

#### 5. Fresh-only deploy gate

Integrasi di:

```txt
src/domain/rules/strategyDecisionRules.ts
src/app/usecases/decideDeploy.ts
src/app/usecases/requestDeploy.ts
```

Aturan wajib jika `screening.requireDetailForDeploy = true`:

- `candidate.dataFreshnessSnapshot.poolDetailFetchedAt` wajib ada.
- `candidate.dataFreshnessSnapshot.isFreshEnoughForDeploy` wajib true.
- `candidate.dlmmMicrostructureSnapshot.activeBinAgeMs <= screening.maxStrategySnapshotAgeMs`.
- `candidate.dlmmMicrostructureSnapshot.activeBinDriftFromDiscovery <= deploy.maxActiveBinDrift`.
- `candidate.dlmmMicrostructureSnapshot.estimatedSlippageBpsForDefaultSize <= screening.maxEstimatedSlippageBps`.
- `candidate.finalStrategyDecision` tidak boleh dibuat dari stale detail.

Jika gagal:

```txt
decision = WATCH atau REJECT
reasonCode = DETAIL_NOT_FRESH_OR_MISSING
```

#### 6. Journal events

Tambahkan journal event types:

```txt
ENRICHMENT_PLAN_BUILT
METEORA_DETAIL_REQUEST_SKIPPED
METEORA_DETAIL_RATE_LIMITED
METEORA_DETAIL_COOLDOWN_STARTED
CANDIDATE_DETAIL_MISSING_DEPLOY_BLOCKED
```

Payload minimal `ENRICHMENT_PLAN_BUILT`:

```ts
{
  candidateCount: number;
  selectedCount: number;
  skippedCount: number;
  topN: number;
  maxDetailRequestsPerCycle: number;
  endpointCooldownUntil?: string | null;
}
```

Payload minimal `METEORA_DETAIL_RATE_LIMITED`:

```ts
{
  poolAddress?: string;
  endpoint: "candidate_detail";
  responseKind: "cloudflare_html" | "json" | "unknown";
  cooldownUntil: string;
  remainingDetailsSkipped: number;
}
```

Payload minimal `CANDIDATE_DETAIL_MISSING_DEPLOY_BLOCKED`:

```ts
{
  poolAddress: string;
  candidateId: string;
  reasonCode: "DETAIL_NOT_FRESH_OR_MISSING";
  requireDetailForDeploy: true;
}
```

#### 7. Operator/reporting visibility

Tambahkan ringkasan di report startup/screening:

```txt
candidateCount
hardFilterPassed
selectedForDetail
skippedDetail
rateLimitCooldownUntil
snapshotOnlyWatchCount
deployBlockedMissingDetailCount
```

Operator harus bisa membedakan:

- tidak ada pool bagus,
- pool ada tapi snapshot-only,
- pool bagus tapi detail API sedang cooldown,
- pool bagus dan fresh-detail eligible.

### Output

Setelah Batch 27:

1. Screening tetap bisa mengambil list pool.
2. Detail Meteora hanya dipanggil untuk top 3–5 candidate.
3. Request detail tidak burst.
4. Jika 429 terjadi, sistem stop enrichment sementara, bukan retry spam.
5. Candidate tanpa fresh detail tidak bisa auto-deploy.
6. Operator bisa melihat kenapa candidate tidak diperkaya detailnya.
7. Dry-run bisa memakai prod-like logic tanpa membanjiri Meteora.
8. Journal punya bukti request budget, cooldown, dan deploy block reason.

### Tests

#### Unit tests

File:

```txt
tests/unit/domain/enrichmentBudgetRules.test.ts
```

Cover:

- Memilih hanya top 5 berdasarkan score.
- `topN = 3` hanya memilih 3 candidate.
- `maxDetailRequestsPerCycle` membatasi selection walau `topN` lebih besar.
- Endpoint cooldown aktif menghasilkan `selectedForDetail = []`.
- Skipped reason benar untuk `outside_top_n`, `cycle_budget_exhausted`, dan `endpoint_in_cooldown`.
- Output deterministic untuk input yang sama.

File:

```txt
tests/unit/app/MeteoraDetailRateLimiter.test.ts
```

Cover:

- Request pertama allowed.
- Request kedua terlalu cepat menghasilkan `waitMs`.
- Window budget habis menghasilkan `window_budget_exhausted`.
- `recordRateLimited()` membuka cooldown.
- Cooldown selesai membuat request allowed lagi.
- `snapshot()` mengembalikan state yang benar.

#### Integration tests

File:

```txt
tests/integration/screeningTopNEnrichment.test.ts
```

Cover:

- Dari 30 candidate, `getCandidateDetails()` dipanggil maksimal 5 kali.
- Dari 30 candidate dengan `detailEnrichmentTopN = 3`, detail dipanggil maksimal 3 kali.
- 429 pada detail kedua menghentikan detail request berikutnya.
- Candidate tanpa detail tetap bisa muncul sebagai WATCH/report-only.
- Candidate tanpa detail tidak eligible deploy.
- Journal memuat `ENRICHMENT_PLAN_BUILT` dan `METEORA_DETAIL_RATE_LIMITED`.

File:

```txt
tests/integration/deployFreshDetailGate.test.ts
```

Cover:

- Candidate tanpa `poolDetailFetchedAt` ditolak deploy.
- Candidate dengan stale `activeBinAgeMs` ditolak deploy.
- Candidate dengan active-bin drift di atas limit ditolak deploy.
- Candidate dengan estimated slippage di atas limit ditolak deploy.
- Candidate dengan fresh detail lolos validator.
- `requireDetailForDeploy = false` hanya boleh dipakai di test/manual mode dan harus tetap menulis warning journal.

### Regression tests wajib

1. 429 tidak membuat runtime crash.
2. 429 tidak menyebabkan retry spam.
3. Endpoint cooldown mencegah request detail lanjutan.
4. Candidate snapshot-only tidak bisa auto-deploy.
5. AI tidak boleh mengubah snapshot-only candidate menjadi deploy.
6. StrategyDecisionValidator menolak stale detail walau AI confidence tinggi.
7. Manual deploy tetap membutuhkan fresh detail kecuali operator memakai explicit override yang dijournal.
8. Dry-run report menunjukkan jumlah request detail yang benar.

### DoD

- `getCandidateDetails()` tidak pernah dipanggil lebih dari `maxDetailRequestsPerCycle` per screening cycle.
- `enrichmentConcurrency` sudah dihapus dari config aktif; detail enrichment sekarang serial-budgeted oleh rate limiter.
- `detailEnrichmentTopN` default prod awal = `5`.
- 429 membuka cooldown endpoint, bukan retry agresif.
- Tidak ada auto-deploy tanpa fresh detail.
- Tidak ada stale cache untuk deploy-critical market/microstructure data.
- Log/journal bisa menjelaskan:
  - berapa candidate di-list,
  - berapa yang lolos hard filter,
  - berapa yang dipilih untuk detail,
  - berapa yang diskip,
  - apakah cooldown aktif,
  - dan apakah deploy diblok karena missing/stale detail.
- Semua test batch hijau.

### Jangan dikerjakan di Batch 27

- Jangan menambahkan AI write privilege.
- Jangan memakai stale market cache untuk deploy.
- Jangan mengubah lifecycle deploy/close/rebalance selain menambah fresh-detail gate.
- Jangan membuat retry unlimited.
- Jangan menjadikan 429 sebagai fatal runtime crash.
- Jangan auto-mutate `user-config.json`.

### Prompt vibecode

```txt
Add Batch 27: Meteora rate-budgeted enrichment and fresh-only deploy gate.

Refactor screening so getCandidateDetails is only called for the deterministic top N candidates after listCandidates, hard filters, and coarse scoring. Add config knobs: detailEnrichmentTopN, detailRequestIntervalMs, maxDetailRequestsPerCycle, maxDetailRequestsPerWindow, detailRequestWindowMs, detailCooldownAfter429Ms, requireDetailForDeploy, allowSnapshotOnlyWatch. Implement pure enrichmentBudgetRules.buildEnrichmentPlan, a MeteoraDetailRateLimiter service, typed MeteoraRateLimitedError mapping for HTTP 429, and screening integration that stops detail enrichment on 429 instead of retry-spamming.

Do not use stale market cache for deploy-critical data. Candidate without fresh detail may be WATCH/report-only but must not be auto-deploy eligible. Add journal events for enrichment plan, skipped detail requests, rate limit cooldown, and deploy blocked due to missing/stale detail. Add unit and integration tests proving only top N details are requested, 429 stops the cycle, cooldown prevents further requests, and deploy requires fresh detail.
```

## 17. Urutan Aktivasi Fitur

Agar bug minimal, aktifkan fitur dalam urutan ini:

1. Config + state machine
2. Queue + persistence
3. Deploy
4. Close + finalizer
5. Reconciliation
6. Management rules
7. Screening rules
8. Rebalance
9. Risk engine
10. Workers
11. CLI/Telegram
12. AI advisory
13. Screening feature enrichment + deterministic strategy suitability
14. AI strategy reviewer recommendation-only
15. StrategyDecisionValidator dry-run integration
16. Real adapters
17. Dry-run simulator
18. Supervised live
19. Live auto-learning wiring + lesson enforcement
20. Meteora rate-budgeted enrichment + fresh-only deploy gate

### Jangan dibalik

- Jangan pasang AI dulu baru state machine.
- Jangan pasang real exchange/chain adapter dulu baru tests.
- Jangan pasang Telegram write command sebelum queue stabil.

---

## 18. Checklist “aman untuk lanjut ke batch berikutnya”

Sebelum pindah batch, jawab “ya” untuk semua ini:

- test batch sekarang hijau,
- lint hijau,
- tidak ada TODO kritis di lifecycle inti,
- tidak ada shortcut yang bypass queue,
- tidak ada write action di health/reporting,
- schema output/input jelas,
- log dan journal cukup untuk debug batch itu.

Kalau ada satu saja “tidak”, jangan lanjut ke batch berikutnya.

---

## 19. Keputusan Produk yang Disarankan

1. **Gunakan TypeScript untuk V2**  
   Ini sangat membantu mengurangi bug state/status.

2. **Gunakan zod untuk semua boundary IO**  
   API response liar harus dibersihkan di adapter layer.

3. **Action queue adalah wajib**  
   Jangan ada direct write dari worker/Telegram/AI.

4. **AI jangan diberi write privilege lebih dulu**  
   Advisory mode dulu sampai supervised run stabil.

5. **Buat fixture dari bug-bug lama**  
   Setiap bug historis diubah jadi regression test.

6. **Simpan decision reason secara structured**  
   Bukan hanya teks; simpan rule code + message.

---

## 20. Penutup

Meridian V2 seharusnya dibangun sebagai **engine trading yang rapi dan bisa diaudit**, bukan sekadar kumpulan tool yang dipanggil AI.

Jika mengikuti batch di atas dengan disiplin, hasilnya akan:

- jauh lebih mudah dibangun lewat vibecode,
- jauh lebih mudah dites,
- jauh lebih mudah diaudit saat bug muncul,
- dan jauh lebih aman untuk live trading bertahap.

## 20. Aturan implementasi greenfield

1. Jangan copy-paste file runtime dari repo lama ke V2.
2. Jangan mempertahankan flow lama hanya karena sudah pernah jalan. Semua flow harus lolos state machine V2.
3. Yang boleh diwariskan hanya: nama rule, threshold bisnis, dan insight edge case.
4. Semua adapter eksternal harus ditulis ulang melalui interface V2, walaupun perilakunya meniru adapter lama.
5. Semua batch harus bisa dikerjakan tanpa membuka source lama, kecuali saat membuat matriks parity atau migration test.
6. Jika ada konflik antara perilaku repo lama dan spesifikasi V2, **spesifikasi V2 yang menang**.

## 21. Definisi sukses “from scratch”

V2 dianggap benar-benar from scratch bila:

- repo baru dapat di-bootstrap tanpa menyalin source lama,
- seluruh folder `src/` mengikuti struktur V2,
- semua rule inti tertulis di domain/application layer baru,
- tidak ada import, copy file, atau coupling ke repo lama,
- parity terhadap versi lama dilakukan lewat test/spec, bukan lewat reuse file.
