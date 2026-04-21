# Meridian V2 Debt And Decisions

Last updated: 2026-04-21 (Batch 12 policy decisions N27/N31 resolved)
Purpose: pisahkan daftar utang teknis/deferred fixes dari progress batch, dan catat keputusan desain yang disengaja agar tidak terus diaudit ulang sebagai bug.

## How To Use
- Jika temuan bisa merusak correctness, safety, atau membuat batch berikutnya berdiri di fondasi rapuh, naikkan jadi `Patch Soon`.
- Jika temuan lebih ke hardening, ergonomics, atau cleanup, simpan di `Deferred`.
- Jika perilaku sudah dipilih dengan sadar dan ada tradeoff jelas, catat di `Design Decisions`.
- Jika item sudah dibenahi, pindahkan ke `Closed`.

## Patch Soon
- Tidak ada item aktif saat ini.

## Deferred
- `N4` orphan temp artifact cleanup di [FileStore.ts](<c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/FileStore.ts:1>)
  Status: deferred
  Kenapa ditunda: disk clutter risk ada, tapi bukan data-loss dan belum mengganggu Batch 7.
  Revisit: sebelum hardening/live-readiness atau jika recovery artifacts mulai sering muncul.

- `N6` recovery syscall overhead di [FileStore.ts](<c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/FileStore.ts:1>)
  Status: deferred
  Kenapa ditunda: ini optimization, bukan correctness issue.
  Revisit: hanya jika profiling menunjukkan bottleneck di polling/list hot path.

- `N7` shared schema cleanup kecil di [schemas.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/types/schemas.ts:1>) dan entity files
  Status: deferred
  Kenapa ditunda: duplication minor, belum memberi leverage besar.
  Revisit: saat ada refactor schema lintas entity atau menjelang Batch 16/18.

- `N10` gateway field pollution lewat spread di [processDeployAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1>)
  Status: deferred
  Kenapa ditunda: mock sekarang patuh, tapi real adapter nanti sebaiknya whitelist field chain-derived saja.
  Revisit: wajib sebelum atau saat Batch 16 real DLMM adapter.

- `N13` strict parsing `postCloseSwap` bisa mengubah misconfiguration hook menjadi `RECONCILIATION_REQUIRED` di [AccountingService.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/services/AccountingService.ts:13>)
  Status: deferred
  Kenapa ditunda: perilaku ini masih fail-safe, tapi error ergonomics-nya kurang jelas karena primitive/array dari hook akan terlihat seperti failure accounting biasa.
  Revisit: saat Batch 8/13 mulai memperluas reconciliation dan observability untuk finalizer hooks.

- `T1` belum ada test concurrency finalizer / lock contention di [closeFlow.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/closeFlow.test.ts:1>)
  Status: deferred
  Kenapa ditunda: lock primitives sudah ada dan path dasar sudah hijau, jadi belum memblokir Batch 8.
  Revisit: sebelum worker reconciliation/management mulai memanggil finalizer lebih paralel.

- `T2` belum ada test posisi berubah antara request dan process sehingga `processCloseAction()` harus fail-fast di [processCloseAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processCloseAction.ts:120>)
  Status: deferred
  Kenapa ditunda: behavior sekarang sudah aman secara runtime karena `assertCloseRequestablePosition()` akan throw dan queue akan menandai action `FAILED`, tetapi regression coverage-nya belum ada.
  Revisit: Batch 8 atau saat close/rebalance interactions mulai lebih kompleks.

- `T3` belum ada test invalid return type dari `postCloseSwapHook` di [finalizeClose.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeClose.ts:338>)
  Status: deferred
  Kenapa ditunda: current schema sudah menangkap type mismatch, hanya saja belum ada regression test khusus.
  Revisit: saat hook ini mulai dipakai nyata atau sebelum Batch 13 operator/reporting observability.

- `T4` coverage gap reconciliation worker untuk fase 2/error path di [reconciliationWorker.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/reconciliationWorker.test.ts:1>)
  Status: deferred
  Kenapa ditunda: skeleton utama Batch 8 sudah tercakup oleh test happy-path/high-signal, tetapi beberapa jalur penting belum diregresikan eksplisit.
  Missing coverage:
  `RECONCILING` action dengan `positionId` null atau local position hilang, multi-wallet cycle, `listPositionsForWallet()` throw -> `MANUAL_REVIEW_REQUIRED`, repeated reconciler runs, unsupported `WAITING_CONFIRMATION` action types.
  Revisit: sebelum reconciliation worker dijadwalkan periodik atau saat Batch 13 observability/reporting mulai membaca hasil reconciliation lebih detail.

- `N14` asimetri submit-path `processCloseAction` vs post-submit persist di [processCloseAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processCloseAction.ts:139>)
  Status: deferred
  Kenapa ditunda: kalau `ClosePositionResultSchema.parse()` gagal atau `closedPositionId` mismatch, action langsung dijatuhkan ke `FAILED` lewat jurnal `CLOSE_SUBMISSION_FAILED`. Padahal analog di Batch 6 (deploy) memilih reconcile-safe untuk scenario "on-chain mungkin sukses tapi response tidak bisa dipercaya". Mock sekarang well-formed jadi tidak memblokir Batch 8, tapi real adapter bisa menghasilkan orphan on-chain close tanpa jejak lokal.
  Revisit: wajib sebelum atau saat Batch 16 real DLMM adapter, atau saat reconciliation path mulai mencari signal untuk recover action `FAILED` yang sebenarnya sukses on-chain.
  Dependency note: Batch 8 reconciliation worker sekarang masih bisa menurunkan action `RECONCILING` menjadi `FAILED` saat recovery startup konservatif, jadi semantik "action FAILED padahal close on-chain sukses" masih satu keluarga risiko dengan item ini.

- `N15` fase snapshot reconciliation belum memakai `positionLock` di [reconcilePortfolio.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:400>)
  Status: deferred
  Kenapa ditunda: pada pola pakai sekarang worker reconciliation dipanggil saat startup/recovery, jadi practical race dengan `ActionQueue` belum jadi blocker. Tetapi fase 3 masih melakukan read-then-write tanpa `positionLock`, sehingga saat nanti worker dijadwalkan periodik paralel dengan queue, snapshot stale bisa meng-overwrite commit action aktif menjadi `RECONCILIATION_REQUIRED`.
  Revisit: wajib sebelum reconciliation worker dijadwalkan periodik atau dijalankan paralel dengan queue; idealnya paling lambat Batch 14/18.

- `N16` management engine menganggap `outOfRangeSince` non-null sebagai source of truth range invalid di [managementRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/managementRules.ts:91>)
  Status: deferred
  Kenapa ditunda: semantik ini memang sengaja mengikuti kontrak state saat ini, tetapi jika reset `outOfRangeSince` terlambat satu cycle sementara `activeBin` sudah kembali in-range, engine bisa tetap menganggap posisi invalid dan mendorong rebalance lebih cepat dari yang diinginkan.
  Revisit: saat Batch 11 rebalance flow resmi atau saat reconciliation/management sinkronisasi state range mulai diperketat lintas modul.

- `N17` screening decision enum melebar dari PRD karena memakai `REJECTED_EXPOSURE` terpisah di [screeningRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:137>) dan [enums.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/types/enums.ts:55>)
  Status: deferred
  Kenapa ditunda: implementasi sekarang masih deterministic dan aman, tetapi kontraknya tidak lagi persis sama dengan PRD §9.2 yang hanya menyebut `REJECTED_HARD_FILTER` / `PASSED_HARD_FILTER`. Ini bisa jadi ambigu saat AI advisory/shortlist consumer mulai membaca eligibility dari decision enum.
  Revisit: wajib diputuskan eksplisit sebelum atau saat Batch 14 AI advisory; pilih antara melipat exposure reject ke `REJECTED_HARD_FILTER` atau merevisi PRD/spec resmi.

- `N18` exposure reject saat ini short-circuit sehingga daftar rejection reason tidak lengkap di [screeningRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:136>)
  Status: deferred
  Kenapa ditunda: tidak mengubah correctness hasil reject, tetapi observability menurun karena candidate yang gagal exposure + hard filter lain hanya membawa reason exposure.
  Revisit: saat operator/reporting mulai membutuhkan penjelasan reject yang lengkap, idealnya sebelum Batch 13 atau 14.

- `N19` risk flag `below_target_volume` terlalu sensitif karena menyala untuk deviasi kecil dari target di [candidateScore.ts](<c:/Users/PC/Desktop/refining-code/meridian_v2/src/domain/scoring/candidateScore.ts:223>)
  Status: deferred
  Kenapa ditunda: hanya mempengaruhi noise level risk flag, bukan shortlist correctness utama. Tetapi threshold sekarang lebih sensitif daripada flag risiko lain yang memakai ambang eksplisit.
  Revisit: saat Batch 14 AI advisory mulai membaca riskFlags sebagai signal ranking/reasoning, atau saat reporting mulai menampilkan flags ke operator.

- `N20` `launchpadPenaltyByName` bisa memakai key string kosong untuk candidate launchpad `null` di [candidateScore.ts](<c:/Users/PC/Desktop/refining-code/meridian_v2/src/domain/scoring/candidateScore.ts:144>)
  Status: deferred
  Kenapa ditunda: ini footgun konfigurasi kecil, bukan bug runtime umum. Tetapi config dengan key `""` bisa diam-diam memberi penalty ke candidate null-launchpad alih-alih fallback ke `narrativePenaltyScore`.
  Revisit: sebelum config screening/scoring mulai dioperasikan lebih luas atau saat Batch 14/16 memperkenalkan config/operator surface yang lebih aktif.

- `F5` duplicate request-accepted journal pattern (`*_REQUEST_ACCEPTED` + `ACTION_ENQUEUED`) di [requestDeploy.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestDeploy.ts:1>) dan [requestRebalance.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestRebalance.ts:1>)
  Status: deferred
  Kenapa ditunda: lebih ke keputusan audit semantics daripada correctness bug.
  Revisit: saat operator/reporting mulai membaca journal untuk counting request volume vs unique action volume.

- `F6` double event submission-failed + `ACTION_FAILED` pattern pada deploy/rebalance
  Status: deferred
  Kenapa ditunda: redundant, tapi tidak merusak state.
  Revisit: saat format observability/journal sudah distabilkan, mungkin Batch 13 atau 18.

- `T5` coverage gap management rules untuk branch individu dan gating detail di [managementRules.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/managementRules.test.ts:1>)
  Status: deferred
  Kenapa ditunda: precedence utama Batch 9 sudah tercakup dan engine bersifat pure, jadi sisa branch coverage belum memblokir batch berikutnya.
  Missing coverage:
  emergency individual (`circuitBreakerState`, `severeTokenRisk`, `liquidityCollapse`, `forcedManualClose`), hard-exit individual (`maxHold`, `maxOutOfRange`, `severeNegativeYield`), rebalance gated-off cases, `partialCloseEnabled=false`, dan numeric `priorityScore` per priority.
  Revisit: sebelum worker management/orchestration mulai mengandalkan engine ini untuk auto-action di Batch 13.

- `T6` coverage gap screening/scoring engine untuk branch individual dan deterministic edge cases di [screeningRules.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/screeningRules.test.ts:1>)
  Status: deferred
  Kenapa ditunda: Batch 10 sudah punya coverage untuk reject, exposure conflict, dan ordering dasar, jadi fondasi pipeline aman. Tetapi banyak branch individual dan deterministic edge case belum diregresikan eksplisit.
  Missing coverage:
  hard filter individual (market cap min/max, TVL, volume, fee/TVL, holder count, bin step, blocked launchpad/deployer/token, pair type, top holder/bot/bundle/wash caps), duplicate token exposure via `tokenYMint`, exposure toggles off, shortlist cutoff, score tie-breaker, numeric breakdown assertions, individual riskFlags, empty candidate list, all rejected list, dan schema reject `maxMarketCapUsd < minMarketCapUsd`.
  Revisit: sebelum Batch 13/14 saat screening output mulai dipakai lebih luas oleh worker/advisory layer.

- `N21` asimetri submit-path `processRebalanceAction` saat close leg pertama gagal parse/mismatch/throw di [processRebalanceAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processRebalanceAction.ts:159>)
  Status: deferred
  Kenapa ditunda: polanya sama dengan `N14`; jika adapter real mengembalikan response buruk setelah close on-chain sebenarnya sukses, action bisa jatuh ke `FAILED` dan meninggalkan orphan close leg tanpa jalur reconcile-safe.
  Revisit: wajib bersama `N14` sebelum atau saat Batch 16 real DLMM adapter.

- `N22` crash gap antara `deployLiquidity()` sukses dan persist phase `REDEPLOY_SUBMITTED` action di [finalizeRebalance.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeRebalance.ts:694>)
  Status: deferred
  Kenapa ditunda: kalau proses mati setelah redeploy submit sukses tetapi sebelum payload/action phase baru tersimpan, restart bisa membaca action masih `CLOSE_SUBMITTED` dan salah menurunkan old leg ke `RECONCILIATION_REQUIRED`, sementara new leg on-chain sudah ada tanpa local state.
  Revisit: sebelum recovery/reconciliation rebalance dianggap production-ready; kemungkinan perlu intermediate commit marker atau journal-based resume strategy.

- `T7` coverage gap rebalance flow di [rebalanceFlow.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/rebalanceFlow.test.ts:1>) dan [reconciliationWorker.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/reconciliationWorker.test.ts:1>)
  Status: deferred
  Kenapa ditunda: skeleton rebalance success/timeout/abort sudah tercakup, tetapi banyak branch recovery-safe dan idempotency edge belum diregresikan eksplisit.
  Missing coverage:
  duplicate rebalance idempotency, submit-OK/persist-fail di `processRebalanceAction()`, redeploy persist-fail di `finalizeRebalance()`, redeploy confirmation non-`OPEN`, terminal re-entry `UNCHANGED`, request reject branches, rebalance from `HOLD`, dan re-entry dari phase `REDEPLOY_SUBMITTED`.
  Revisit: sebelum Batch 13 worker/reporting mulai lebih bergantung pada rebalance observability dan recovery semantics.

- `N24` `circuitBreakerCooldownMin` belum dipakai untuk expiry/transisi `ON -> COOLDOWN -> OFF` di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:206>)
  Status: deferred
  Kenapa ditunda: Batch 12 baru membangun pure guardrail engine dasar; cooldown clock/state transition belum dibutuhkan sampai worker orchestration benar-benar mulai mengelola breaker lifecycle.
  Revisit: wajib saat Batch 13/14 mulai mengoperasikan circuit breaker end-to-end.

- `N25` risk engine masih bisa menghasilkan blocking reason yang redundant (`daily loss limit` + `circuit breaker`) di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:438>)
  Status: deferred
  Kenapa ditunda: tidak mengubah correctness keputusan block, hanya menambah noise observability.
  Revisit: saat reporting/operator UI mulai menampilkan blocking reasons ke manusia.

- `N26` `PortfolioRiskActionSchema` masih berdiri sendiri dan belum diturunkan dari enum action canonical di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:10>)
  Status: deferred
  Kenapa ditunda: whitelist action risk saat ini kecil dan eksplisit, tetapi ada drift risk jika enum action lifecycle bertambah di masa depan.
  Revisit: saat Batch 13 mengintegrasikan risk engine ke worker/action execution surface yang lebih luas.

- `N28` `maxConcurrentPositions` masih hanya membaca `openPositions`; ketergantungan pada `pendingActions` sebagai guard write terpisah belum terdokumentasi penuh di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:451>)
  Status: deferred
  Kenapa ditunda: perilaku sekarang aman karena `pendingActions >= 1` sudah memblok write baru, tetapi coupling kedua rule ini masih implisit.
  Revisit: saat worker orchestration mulai menghitung kapasitas deploy secara real-time.

- `N29` denominator `dailyLossPct` masih memakai `walletBalance` saat ini, belum start-of-day equity, di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:190>)
  Status: deferred
  Kenapa ditunda: PRD belum menulis eksplisit apakah limit dibaca terhadap equity awal hari atau equity saat ini. Mengubah denominator sekarang akan mengubah semantics drawdown/circuit-breaker lintas semua caller.
  Revisit: putuskan sebelum worker/reporting mulai menjelaskan risk percentage ke operator.

- `N30` reserve guard masih mengandalkan kontrak caller bahwa `reservedBalance` sudah merepresentasikan buffer yang dilindungi; schema belum mengekspresikan invariant itu secara eksplisit di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:479>)
  Status: deferred
  Kenapa ditunda: guard saat ini sudah memblok ketika reserve snapshot jatuh di bawah minimum, tetapi contract antara `walletBalance`, `availableBalance`, dan `reservedBalance` belum diformalisasi di schema. Perubahan penuh lebih aman dilakukan saat worker Batch 13 benar-benar menjadi producer utama snapshot portfolio.
  Revisit: saat integrasi worker risk/orchestration sudah final, lalu kencangkan schema atau builder snapshot di boundary.

- `N32` builder `PortfolioState` canonical belum ada; worker Batch 13 berisiko membentuk snapshot risk dengan logika yang tersebar di banyak tempat di [PortfolioState.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/entities/PortfolioState.ts:1>)
  Status: deferred
  Kenapa ditunda: evaluator risk sudah siap menerima snapshot, tetapi belum ada service/usecase tunggal yang mengagregasi wallet balance, reserve, pending actions, exposure, dan daily realized PnL menjadi `PortfolioState`. Tanpa builder resmi, tiap worker bisa membangun snapshot dengan invariant yang berbeda.
  Revisit: wajib dikerjakan di Batch 13 sebelum risk engine dipakai lebih dari satu orchestration path.

- `N33` sumber `recentNewDeploys` untuk window 1 jam belum dibakukan di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:60>)
  Status: deferred
  Kenapa ditunda: evaluator hanya menerima angka final, tetapi belum ada helper/query resmi yang menghitung deploy baru dari journal/action repo dalam sliding window. Tanpa definisi ini, worker Batch 13 bisa memakai sumber atau kriteria hitung yang saling berbeda.
  Revisit: wajib diputuskan saat Batch 13 mulai meng-wire rule `maxNewDeploysPerHour`.

- `T8` coverage gap risk engine setelah hardening Batch 12 di [riskRules.test.ts](<c:/Users/PC/Desktop/meridian_v2/tests/unit/riskRules.test.ts:1>)
  Status: deferred
  Kenapa ditunda: core semantics Batch 12 sudah diregresikan, tetapi beberapa branch penting dan ambiguity cases belum diuji eksplisit.
  Missing coverage:
  `maxConcurrentPositions` on deploy, `pendingActions` block, `maxRebalancesPerPosition`, `maxNewDeploysPerHour`, rebalance shrink (`allocationDeltaUsd < 0`), pool-same-as-old rebalance projection, circuit breaker `COOLDOWN` pass-through/expiry semantics, recovery of loss back below limit, dan allow-assertion individual untuk `CLAIM_FEES`/`PARTIAL_CLOSE`.
  Revisit: sebelum Batch 13 worker benar-benar mengonsumsi evaluator ini secara langsung.

## Design Decisions
- Deploy request tetap menulis via `ActionQueue`; `requestDeploy()` tidak boleh direct write ke state/action terminal.
  Rationale: single-writer principle.
  Files: [requestDeploy.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestDeploy.ts:1>), [ActionQueue.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/services/ActionQueue.ts:1>)

- Pending deploy position baru dimaterialisasi setelah `deployLiquidity()` sukses dan `positionId` canonical sudah diketahui.
  Rationale: hindari placeholder position palsu sebelum submit gateway benar-benar berhasil.
  Tradeoff: sebelum submit sukses, belum ada row position lokal untuk deploy tersebut.
  Files: [processDeployAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1>)

- Confirm deploy memakai `DlmmGateway.getPosition(positionId)` sebagai confirmation check untuk Batch 6.
  Rationale: cukup untuk mock/integration sekarang.
  Tradeoff: real adapter nanti mungkin perlu signal yang lebih kuat daripada sekadar object exists.
  Revisit: saat Batch 16 real adapter.

- Jika submit on-chain sukses tetapi persist lokal gagal, flow dipaksa tetap recoverable lewat `WAITING_CONFIRMATION` + `RECONCILIATION_REQUIRED`, bukan dijatuhkan ke `FAILED`.
  Rationale: lebih aman punya action recoverable daripada orphan on-chain position tanpa jejak lokal yang bisa di-follow-up.
  Files: [processDeployAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1>)

- Prioritas implementasi saat ini: patch correctness/safety dulu, cleanup dan ergonomics setelah fondasi lifecycle stabil.
  Rationale: proyek masih di fase greenfield lifecycle, jadi debt management harus ketat terhadap hal yang benar-benar berisiko ke production.

- Idempotency close saat ini diturunkan dari `{ wallet, type, positionId, reason }` tanpa komponen waktu/nonce di [requestClose.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestClose.ts:77>)
  Rationale: untuk sekarang close request dengan payload identik dianggap duplicate intent dan harus ditahan oleh idempotency guard.
  Tradeoff: dua request operator terpisah dengan reason yang sama akan collide.
  Revisit: saat Batch 14 operator interface/CLI mulai butuh explicit retry or override semantics.

- Reconciliation worker memproses `WAITING_CONFIRMATION` lebih dulu baru missing snapshot di [reconcilePortfolio.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:239>)
  Rationale: jika wallet snapshot lagging, action deploy/close yang sebenarnya masih recoverable tidak boleh keburu dipaksa ke jalur missing-snapshot lebih kasar.
  Tradeoff: snapshot drift detection sengaja sedikit ditunda demi memberi ruang recovery action yang lebih deterministik.

- Startup recovery untuk action yang tertinggal di `RECONCILING` bersifat konservatif di [reconcilePortfolio.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:141>)
  Rationale: Batch 8 belum punya resumption logic granular untuk melanjutkan finalizer dari tengah; lebih aman menurunkannya ke `FAILED` + `RECONCILIATION_REQUIRED`.
  Tradeoff: recovery tidak mencoba resume in-place, jadi follow-up tetap bergantung pada reconciliation/manual review berikutnya.

- Management engine menempatkan `RECONCILE_ONLY` setelah hard-exit tetapi sebelum maintenance di [managementRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/managementRules.ts:175>)
  Rationale: jika snapshot belum layak untuk maintenance decision, engine harus menahan claim/partial-close/rebalance, tetapi emergency dan hard-exit tetap boleh menang lebih dulu.
  Tradeoff: maintenance opportunity yang valid bisa sengaja ditunda satu cycle demi menjaga deterministic safety.

- Screening pipeline memaksa hard filter selesai sebelum scoring/shortlist di [screeningRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:74>)
  Rationale: kandidat yang gagal hard filter tidak boleh masuk ranking atau shortlist deterministic, sehingga AI layer nanti hanya bekerja pada kandidat yang memang sudah lolos boundary safety.
  Tradeoff: candidate dengan skor potensial bagus tetap dibuang total jika gagal filter keras, walau margin gagalnya tipis.

- Rebalance resmi dipertahankan sebagai satu action `REBALANCE` dengan phase eksplisit di `resultPayload`, bukan dipecah menjadi action `CLOSE` + `DEPLOY` terpisah di queue.
  Rationale: satu action memudahkan idempotency, observability, dan recovery path untuk dua leg yang secara bisnis adalah satu intent rebalance.
  Tradeoff: action bisa tetap berada di `WAITING_CONFIRMATION` sambil `resultPayload.phase` berubah dari `CLOSE_SUBMITTED` ke `REDEPLOY_SUBMITTED`, sehingga consumer harus membaca phase payload, bukan hanya status action.
  Files: [processRebalanceAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processRebalanceAction.ts:1>), [finalizeRebalance.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeRebalance.ts:1>)

- Drawdown warning di risk engine sekarang mulai menyala pada 50% dari `dailyLossLimitPct` di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:177>)
  Rationale: memberi sinyal lebih dini sebelum limit penuh tercapai, tanpa harus menunggu circuit breaker menyala.
  Tradeoff: threshold warning ini adalah pilihan desain internal, belum datang eksplisit dari PRD; jika operator nanti butuh sensitivitas berbeda, kemungkinan perlu dinaikkan ke config.

- Portfolio risk engine sekarang memakai konvensi unit USD-equivalent untuk reserve guard (`minReserveUsd`) di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:19>) dan [configSchema.ts](<c:/Users/PC/Desktop/meridian_v2/src/infra/config/configSchema.ts:25>)
  Rationale: evaluator risk sudah membandingkan allocation, capital usage, realized PnL, dan exposure terhadap snapshot nilai yang sama; menyamakan reserve ke unit yang sama menghindari drift SOL-vs-USD di boundary.
  Tradeoff: nama ini sekarang menyimpang dari wording PRD lama (`minReserveSol`), sehingga integrasi/operator docs harus mengikuti naming baru.

- Threshold `max` pada capital usage dan exposure di risk engine sekarang diperlakukan inclusive (`>=`) di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:461>)
  Rationale: untuk guardrail risk, “menyentuh limit” dianggap sudah tidak aman untuk ekspansi posisi baru.
  Tradeoff: perilaku ini lebih konservatif daripada interpretasi exclusive-cap.

- `REBALANCE` tidak dihitung sebagai `maxNewDeploysPerHour` di [riskRules.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:497>) (resolves `N27`)
  Rationale: limit hourly-new-deploys bertujuan menahan ekspansi eksposur baru (posisi baru, capital committed baru); rebalance hanya menggeser range posisi yang sudah ada dan sudah punya guard terpisah `maxRebalancesPerPosition`. Menghitungnya berarti double-regulate dan bisa memblok reposisi sah di market volatil.
  Tradeoff: jika nanti operator ingin rate-limit total on-chain write (termasuk rebalance), perlu limit baru yang terpisah dari `maxNewDeploysPerHour`.

- Unit bridge SOL↔USD dikerjakan di boundary worker lewat `PriceGateway` (konversi sekali di entry Batch 13), bukan disimpan sebagai rate di `PortfolioState` (resolves `N31`)
  Rationale: harga = dependency eksternal yang berubah cepat, natural diletakkan sebagai adapter port. Menaruh rate di `PortfolioState` akan mencampur "apa isi portfolio" dengan "dengan rate berapa kita menilainya", dan membuat snapshot basi ketika rate berubah. Risk engine tetap pure USD tanpa perlu tahu soal konversi.
  Tradeoff: tiap worker yang menyuplai snapshot ke evaluator wajib melewati `PriceGateway` terlebih dulu; belum ada adapter price yang tersedia sampai Batch 13 dikerjakan.
  Implementation note: Batch 13 harus memperkenalkan `PriceGateway` port + adapter mock, lalu `PortfolioState` builder (`N32`) memakainya untuk memproduksi semua nilai USD-equivalent sebelum evaluator dipanggil.

## Closed
- `F1` transition ke `OPEN` tidak lagi hardcoded dari literal `DEPLOYING`; sekarang memakai `pendingPosition.status`.
- `F2` gateway position hanya dianggap confirmed jika status benar-benar `OPEN`.
- `F3` submit on-chain sukses + persist lokal gagal tidak lagi orphan silent; flow dinaikkan ke reconcile-safe path.
- `F4` regression test untuk gateway non-`OPEN` sudah ada.
- `F7` regression test re-confirmation idempotent sudah ada.
- `N8` partial-commit risk di confirm deploy happy path sudah ditutup dengan ordering commit yang lebih aman.
- `N9` partial-commit risk di confirm deploy timeout path sudah ditutup dengan ordering commit yang lebih aman.
- `N12` empty error message sekarang dinormalisasi jadi safe fallback.
- `N5` cross-validation `Action.positionId` vs `Action.type` sekarang ditegakkan di schema `Action`.
- `N11` `outOfRangeSince` sekarang dinormalisasi saat deploy confirmed out-of-range dan dipertahankan konsisten saat close finalization.
- `F8` enqueue idempotency sekarang atomic; duplicate action tidak lagi muncul pada request paralel dengan idempotency key yang sama.
- `N23` reconciliation worker sekarang memetakan outcome terminal (`TIMED_OUT`, aborted, failed-finalization) ke `MANUAL_REVIEW_REQUIRED`, bukan `REQUIRES_RETRY`, sehingga observability tidak lagi mengisyaratkan auto-retry palsu.
- `N24a` rebalance risk projection tidak lagi double-count capital/exposure; evaluator sekarang men-net-out posisi lama saat action `REBALANCE`.
- `N24b` risk engine/config reserve unit drift sudah ditutup dengan konvensi `minReserveUsd`.
- `N24c` threshold `max` di capital usage dan exposure sekarang konsisten inclusive.
- `N29a` rebalance token exposure release sekarang aman terhadap perbedaan ordering `tokenX/tokenY` vs `base/quote`; evaluator melepas exposure dari union mint position yang sudah dide-dupe.

## Next Review Gate
- Review file ini sebelum mulai Batch 7.
- Review lagi sebelum Batch 16 untuk semua item yang menyentuh real adapter boundary.
- Review terakhir sebelum Batch 18/live-readiness untuk memastikan tidak ada deferred item yang ternyata masih high-impact.
