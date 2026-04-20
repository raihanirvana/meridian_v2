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
    scoring/
      candidateScore.ts
      managementPriority.ts
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
- `screeningSnapshot`
- `tokenRiskSnapshot`
- `smartMoneySnapshot`
- `hardFilterPassed`
- `score`
- `scoreBreakdown`
- `decision`
- `decisionReason`
- `createdAt`

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
- action states CLOSING -> CLOSE_CONFIRMED -> RECONCILING -> DONE
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
13. Real adapters
14. Dry-run simulator
15. Supervised live

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
