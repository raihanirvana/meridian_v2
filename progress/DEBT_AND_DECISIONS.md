# Meridian V2 Debt And Decisions

Last updated: 2026-04-25 (Batch 25 AI rebalance planner)
Purpose: pisahkan daftar utang teknis/deferred fixes dari progress batch, dan catat keputusan desain yang disengaja agar tidak terus diaudit ulang sebagai bug.

## How To Use

- Jika temuan bisa merusak correctness, safety, atau membuat batch berikutnya berdiri di fondasi rapuh, naikkan jadi `Patch Soon`.
- Jika temuan lebih ke hardening, ergonomics, atau cleanup, simpan di `Deferred`.
- Jika perilaku sudah dipilih dengan sadar dan ada tradeoff jelas, catat di `Design Decisions`.
- Jika item sudah dibenahi, pindahkan ke `Closed`.

## Patch Soon

- Tidak ada item aktif saat ini.

## Deferred

- `N71` Batch 25 AI rebalance pool snapshot sudah memakai metadata entry + fresh pool active-bin, tetapi belum enrichment market pool live penuh
  Status: deferred
  Kenapa ditunda: planner/validator/queue boundary sudah tersedia, dan snapshot AI sekarang tidak lagi memakai value posisi sebagai TVL pool serta memakai `getPoolInfo()` untuk fresh active bin. Namun `runManagementCycle()` masih belum punya feed live penuh untuk fee velocity, trend direction/mean reversion real-time, dan depth rich snapshot setelah posisi berjalan.
  Revisit: saat TokenIntel/PoolDiscovery atau pool-memory snapshot feed siap dipakai oleh management worker; sebelum menaikkan AI rebalance dari `advisory` ke `dry_run` atau `constrained_action`.

- `N4` orphan temp artifact cleanup di [FileStore.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/FileStore.ts:1)
  Status: deferred
  Kenapa ditunda: disk clutter risk ada, tapi bukan data-loss dan belum mengganggu Batch 7.
  Revisit: sebelum hardening/live-readiness atau jika recovery artifacts mulai sering muncul.

- `N6` recovery syscall overhead di [FileStore.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/FileStore.ts:1)
  Status: deferred
  Kenapa ditunda: ini optimization, bukan correctness issue.
  Revisit: hanya jika profiling menunjukkan bottleneck di polling/list hot path.

- `N7` shared schema cleanup kecil di [schemas.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/types/schemas.ts:1) dan entity files
  Status: deferred
  Kenapa ditunda: duplication minor, belum memberi leverage besar.
  Revisit: saat ada refactor schema lintas entity atau menjelang Batch 16/18.

- `N10` gateway field pollution lewat spread di [processDeployAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1)
  Status: deferred
  Kenapa ditunda: mock sekarang patuh, tapi real adapter nanti sebaiknya whitelist field chain-derived saja.
  Revisit: wajib sebelum atau saat Batch 16 real DLMM adapter.

- `N13` strict parsing `postCloseSwap` bisa mengubah misconfiguration hook menjadi `RECONCILIATION_REQUIRED` di [AccountingService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AccountingService.ts:13)
  Status: deferred
  Kenapa ditunda: perilaku ini masih fail-safe, tapi error ergonomics-nya kurang jelas karena primitive/array dari hook akan terlihat seperti failure accounting biasa.
  Revisit: saat Batch 8/13 mulai memperluas reconciliation dan observability untuk finalizer hooks.

- `T1` belum ada test concurrency finalizer / lock contention di [closeFlow.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/closeFlow.test.ts:1)
  Status: deferred
  Kenapa ditunda: lock primitives sudah ada dan path dasar sudah hijau, jadi belum memblokir Batch 8.
  Revisit: sebelum worker reconciliation/management mulai memanggil finalizer lebih paralel.

- `T2` belum ada test posisi berubah antara request dan process sehingga `processCloseAction()` harus fail-fast di [processCloseAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processCloseAction.ts:120)
  Status: deferred
  Kenapa ditunda: behavior sekarang sudah aman secara runtime karena `assertCloseRequestablePosition()` akan throw dan queue akan menandai action `FAILED`, tetapi regression coverage-nya belum ada.
  Revisit: Batch 8 atau saat close/rebalance interactions mulai lebih kompleks.

- `T3` belum ada test invalid return type dari `postCloseSwapHook` di [finalizeClose.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeClose.ts:338)
  Status: deferred
  Kenapa ditunda: current schema sudah menangkap type mismatch, hanya saja belum ada regression test khusus.
  Revisit: saat hook ini mulai dipakai nyata atau sebelum Batch 13 operator/reporting observability.

- `T4` coverage gap reconciliation worker untuk fase 2/error path di [reconciliationWorker.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/reconciliationWorker.test.ts:1)
  Status: deferred
  Kenapa ditunda: skeleton utama Batch 8 sudah tercakup oleh test happy-path/high-signal, tetapi beberapa jalur penting belum diregresikan eksplisit.
  Missing coverage:
  `RECONCILING` action dengan `positionId` null atau local position hilang, multi-wallet cycle, `listPositionsForWallet()` throw -> `MANUAL_REVIEW_REQUIRED`, repeated reconciler runs, unsupported `WAITING_CONFIRMATION` action types.
  Revisit: sebelum reconciliation worker dijadwalkan periodik atau saat Batch 13 observability/reporting mulai membaca hasil reconciliation lebih detail.

- `N14` asimetri submit-path `processCloseAction` vs post-submit persist di [processCloseAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processCloseAction.ts:139)
  Status: deferred
  Kenapa ditunda: kalau `ClosePositionResultSchema.parse()` gagal atau `closedPositionId` mismatch, action langsung dijatuhkan ke `FAILED` lewat jurnal `CLOSE_SUBMISSION_FAILED`. Padahal analog di Batch 6 (deploy) memilih reconcile-safe untuk scenario "on-chain mungkin sukses tapi response tidak bisa dipercaya". Mock sekarang well-formed jadi tidak memblokir Batch 8, tapi real adapter bisa menghasilkan orphan on-chain close tanpa jejak lokal.
  Revisit: wajib sebelum atau saat Batch 16 real DLMM adapter, atau saat reconciliation path mulai mencari signal untuk recover action `FAILED` yang sebenarnya sukses on-chain.
  Dependency note: Batch 8 reconciliation worker sekarang masih bisa menurunkan action `RECONCILING` menjadi `FAILED` saat recovery startup konservatif, jadi semantik "action FAILED padahal close on-chain sukses" masih satu keluarga risiko dengan item ini.

- `N15` fase snapshot reconciliation belum memakai `positionLock` di [reconcilePortfolio.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:400)
  Status: deferred
  Kenapa ditunda: pada pola pakai sekarang worker reconciliation dipanggil saat startup/recovery, jadi practical race dengan `ActionQueue` belum jadi blocker. Tetapi fase 3 masih melakukan read-then-write tanpa `positionLock`, sehingga saat nanti worker dijadwalkan periodik paralel dengan queue, snapshot stale bisa meng-overwrite commit action aktif menjadi `RECONCILIATION_REQUIRED`.
  Revisit: wajib sebelum reconciliation worker dijadwalkan periodik atau dijalankan paralel dengan queue; idealnya paling lambat Batch 14/18.

- `N16` management engine menganggap `outOfRangeSince` non-null sebagai source of truth range invalid di [managementRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/managementRules.ts:91)
  Status: deferred
  Kenapa ditunda: semantik ini memang sengaja mengikuti kontrak state saat ini, tetapi jika reset `outOfRangeSince` terlambat satu cycle sementara `activeBin` sudah kembali in-range, engine bisa tetap menganggap posisi invalid dan mendorong rebalance lebih cepat dari yang diinginkan.
  Revisit: saat Batch 11 rebalance flow resmi atau saat reconciliation/management sinkronisasi state range mulai diperketat lintas modul.

- `N17` screening decision enum melebar dari PRD karena memakai `REJECTED_EXPOSURE` terpisah di [screeningRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:137) dan [enums.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/types/enums.ts:55)
  Status: deferred
  Kenapa ditunda: implementasi sekarang masih deterministic dan aman, tetapi kontraknya tidak lagi persis sama dengan PRD §9.2 yang hanya menyebut `REJECTED_HARD_FILTER` / `PASSED_HARD_FILTER`. Ini bisa jadi ambigu saat AI advisory/shortlist consumer mulai membaca eligibility dari decision enum.
  Revisit: wajib diputuskan eksplisit sebelum atau saat Batch 14 AI advisory; pilih antara melipat exposure reject ke `REJECTED_HARD_FILTER` atau merevisi PRD/spec resmi.

- `N18` exposure reject saat ini short-circuit sehingga daftar rejection reason tidak lengkap di [screeningRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:136)
  Status: deferred
  Kenapa ditunda: tidak mengubah correctness hasil reject, tetapi observability menurun karena candidate yang gagal exposure + hard filter lain hanya membawa reason exposure.
  Revisit: saat operator/reporting mulai membutuhkan penjelasan reject yang lengkap, idealnya sebelum Batch 13 atau 14.

- `N19` risk flag `below_target_volume` terlalu sensitif karena menyala untuk deviasi kecil dari target di [candidateScore.ts](c:/Users/PC/Desktop/refining-code/meridian_v2/src/domain/scoring/candidateScore.ts:223)
  Status: deferred
  Kenapa ditunda: hanya mempengaruhi noise level risk flag, bukan shortlist correctness utama. Tetapi threshold sekarang lebih sensitif daripada flag risiko lain yang memakai ambang eksplisit.
  Revisit: saat Batch 14 AI advisory mulai membaca riskFlags sebagai signal ranking/reasoning, atau saat reporting mulai menampilkan flags ke operator.

- `N20` `launchpadPenaltyByName` bisa memakai key string kosong untuk candidate launchpad `null` di [candidateScore.ts](c:/Users/PC/Desktop/refining-code/meridian_v2/src/domain/scoring/candidateScore.ts:144)
  Status: deferred
  Kenapa ditunda: ini footgun konfigurasi kecil, bukan bug runtime umum. Tetapi config dengan key `""` bisa diam-diam memberi penalty ke candidate null-launchpad alih-alih fallback ke `narrativePenaltyScore`.
  Revisit: sebelum config screening/scoring mulai dioperasikan lebih luas atau saat Batch 14/16 memperkenalkan config/operator surface yang lebih aktif.

- `F5` duplicate request-accepted journal pattern (`*_REQUEST_ACCEPTED` + `ACTION_ENQUEUED`) di [requestDeploy.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestDeploy.ts:1) dan [requestRebalance.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestRebalance.ts:1)
  Status: deferred
  Kenapa ditunda: lebih ke keputusan audit semantics daripada correctness bug.
  Revisit: saat operator/reporting mulai membaca journal untuk counting request volume vs unique action volume.

- `F6` double event submission-failed + `ACTION_FAILED` pattern pada deploy/rebalance
  Status: deferred
  Kenapa ditunda: redundant, tapi tidak merusak state.
  Revisit: saat format observability/journal sudah distabilkan, mungkin Batch 13 atau 18.

- `T5` coverage gap management rules untuk branch individu dan gating detail di [managementRules.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/managementRules.test.ts:1)
  Status: deferred
  Kenapa ditunda: precedence utama Batch 9 sudah tercakup dan engine bersifat pure, jadi sisa branch coverage belum memblokir batch berikutnya.
  Missing coverage:
  emergency individual (`circuitBreakerState`, `severeTokenRisk`, `liquidityCollapse`, `forcedManualClose`), hard-exit individual (`maxHold`, `maxOutOfRange`, `severeNegativeYield`), rebalance gated-off cases, `partialCloseEnabled=false`, dan numeric `priorityScore` per priority.
  Revisit: sebelum worker management/orchestration mulai mengandalkan engine ini untuk auto-action di Batch 13.

- `T6` coverage gap screening/scoring engine untuk branch individual dan deterministic edge cases di [screeningRules.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/screeningRules.test.ts:1)
  Status: deferred
  Kenapa ditunda: Batch 10 sudah punya coverage untuk reject, exposure conflict, dan ordering dasar, jadi fondasi pipeline aman. Tetapi banyak branch individual dan deterministic edge case belum diregresikan eksplisit.
  Missing coverage:
  hard filter individual (market cap min/max, TVL, volume, fee/TVL, holder count, bin step, blocked launchpad/deployer/token, pair type, top holder/bot/bundle/wash caps), duplicate token exposure via `tokenYMint`, exposure toggles off, shortlist cutoff, score tie-breaker, numeric breakdown assertions, individual riskFlags, empty candidate list, all rejected list, dan schema reject `maxMarketCapUsd < minMarketCapUsd`.
  Revisit: sebelum Batch 13/14 saat screening output mulai dipakai lebih luas oleh worker/advisory layer.

- `N21` asimetri submit-path `processRebalanceAction` saat close leg pertama gagal parse/mismatch/throw di [processRebalanceAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processRebalanceAction.ts:159)
  Status: deferred
  Kenapa ditunda: polanya sama dengan `N14`; jika adapter real mengembalikan response buruk setelah close on-chain sebenarnya sukses, action bisa jatuh ke `FAILED` dan meninggalkan orphan close leg tanpa jalur reconcile-safe.
  Revisit: wajib bersama `N14` sebelum atau saat Batch 16 real DLMM adapter.

- `N22` crash gap antara `deployLiquidity()` sukses dan persist phase `REDEPLOY_SUBMITTED` action di [finalizeRebalance.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeRebalance.ts:694)
  Status: deferred
  Kenapa ditunda: kalau proses mati setelah redeploy submit sukses tetapi sebelum payload/action phase baru tersimpan, restart bisa membaca action masih `CLOSE_SUBMITTED` dan salah menurunkan old leg ke `RECONCILIATION_REQUIRED`, sementara new leg on-chain sudah ada tanpa local state.
  Revisit: sebelum recovery/reconciliation rebalance dianggap production-ready; kemungkinan perlu intermediate commit marker atau journal-based resume strategy.

- `T7` coverage gap rebalance flow di [rebalanceFlow.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/rebalanceFlow.test.ts:1) dan [reconciliationWorker.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/reconciliationWorker.test.ts:1)
  Status: deferred
  Kenapa ditunda: skeleton rebalance success/timeout/abort sudah tercakup, tetapi banyak branch recovery-safe dan idempotency edge belum diregresikan eksplisit.
  Missing coverage:
  duplicate rebalance idempotency, submit-OK/persist-fail di `processRebalanceAction()`, redeploy persist-fail di `finalizeRebalance()`, redeploy confirmation non-`OPEN`, terminal re-entry `UNCHANGED`, request reject branches, rebalance from `HOLD`, dan re-entry dari phase `REDEPLOY_SUBMITTED`.
  Revisit: sebelum Batch 13 worker/reporting mulai lebih bergantung pada rebalance observability dan recovery semantics.

- `N25` risk engine masih bisa menghasilkan blocking reason yang redundant (`daily loss limit` + `circuit breaker`) di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:438)
  Status: deferred
  Kenapa ditunda: tidak mengubah correctness keputusan block, hanya menambah noise observability.
  Revisit: saat reporting/operator UI mulai menampilkan blocking reasons ke manusia.

- `N26` `PortfolioRiskActionSchema` masih berdiri sendiri dan belum diturunkan dari enum action canonical di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:10)
  Status: deferred
  Kenapa ditunda: whitelist action risk saat ini kecil dan eksplisit, tetapi ada drift risk jika enum action lifecycle bertambah di masa depan.
  Revisit: saat Batch 13 mengintegrasikan risk engine ke worker/action execution surface yang lebih luas.

- `N28` `maxConcurrentPositions` masih hanya membaca `openPositions`; ketergantungan pada `pendingActions` sebagai guard write terpisah belum terdokumentasi penuh di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:451)
  Status: deferred
  Kenapa ditunda: perilaku sekarang aman karena `pendingActions >= 1` sudah memblok write baru, tetapi coupling kedua rule ini masih implisit.
  Revisit: saat worker orchestration mulai menghitung kapasitas deploy secara real-time.

- `N29` denominator `dailyLossPct` masih memakai `walletBalance` saat ini, belum start-of-day equity, di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:190)
  Status: deferred
  Kenapa ditunda: PRD belum menulis eksplisit apakah limit dibaca terhadap equity awal hari atau equity saat ini. Mengubah denominator sekarang akan mengubah semantics drawdown/circuit-breaker lintas semua caller.
  Revisit: putuskan sebelum worker/reporting mulai menjelaskan risk percentage ke operator.

- `N30` reserve guard masih mengandalkan kontrak caller bahwa `reservedBalance` sudah merepresentasikan buffer yang dilindungi; schema belum mengekspresikan invariant itu secara eksplisit di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:479)
  Status: deferred
  Kenapa ditunda: guard saat ini sudah memblok ketika reserve snapshot jatuh di bawah minimum, tetapi contract antara `walletBalance`, `availableBalance`, dan `reservedBalance` belum diformalisasi di schema. Perubahan penuh lebih aman dilakukan saat worker Batch 13 benar-benar menjadi producer utama snapshot portfolio.
  Revisit: saat integrasi worker risk/orchestration sudah final, lalu kencangkan schema atau builder snapshot di boundary.

- `N34` management worker saat ini masih belum men-dispatch `PARTIAL_CLOSE`; `CLAIM_FEES` sudah punya flow resmi, tetapi partial close masih di-skip sebagai unsupported di [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:171)
  Status: deferred
  Kenapa ditunda: partial close masih butuh pipeline request/process/finalize yang setara dengan close/claim/rebalance. Setelah Batch 20, coverage auto-management tinggal kurang di partial-close path.
  Revisit: saat flow request/process/finalize untuk `PARTIAL_CLOSE` masuk roadmap aktif.

- `N36` screening worker orchestration runtime belum ada di Batch 18, tetapi sudah ditutup di Batch 20 lewat `runScreeningCycle()`, `runScreeningWorker()`, adaptive interval helper, dan wiring composition root live
  Status: closed
  Kenapa ditutup: runtime screening sekarang sudah punya worker resmi, scheduler metadata, policy/signal-weight injection, candidate detail enrichment, AI rerank, dan live bootstrap wiring opsional via env-backed gateways.

- `N37` `PortfolioStateBuilder` sekarang sudah mengecek staleness `asOf` dari snapshot wallet dan price, lalu melempar `PortfolioSnapshotStaleError` bila data terlalu basi
  Status: closed
  Kenapa ditutup: portfolio snapshot tidak lagi dibangun dari balance/quote eksternal yang stale, sehingga risk/reporting runtime tidak diam-diam memakai valuation basi.

- `N38` `signalProvider` sekarang tidak lagi menjatuhkan seluruh management cycle; failure per posisi diubah menjadi journal `MANAGEMENT_SIGNAL_PROVIDER_FAILED` + fallback `RECONCILE_ONLY` di `runManagementCycle.ts`
  Status: closed
  Kenapa ditutup: satu posisi dengan signal/enrichment gagal tidak lagi menggagalkan cycle penuh; worker bisa lanjut memproses posisi lain secara aman sambil tetap memberi audit trail yang jelas.

- `N39` AI advisory timeout saat ini hanya memutus promise lokal; underlying call belum bisa di-abort karena `LlmGateway` belum membawa `AbortSignal` atau cancellation contract di [AiAdvisoryService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AiAdvisoryService.ts:70)
  Status: deferred
  Kenapa ditunda: pada mock Batch 15 ini tidak memengaruhi correctness karena fallback tetap jalan, tetapi saat adapter LLM nyata dipasang, timeout tanpa abort bisa meninggalkan request HTTP menggantung dan menumpuk di background.
  Revisit: saat Batch 16 memasang adapter LLM nyata; pertimbangkan menambah `AbortSignal` ke contract `LlmGateway`.

- `N40` `JupiterApiSwapGateway.executeSwap()` masih memerlukan execution bridge eksplisit (`executeBaseUrl`) karena repo belum membawa signer/runtime submit flow resmi; adapter belum bisa mengeksekusi swap langsung hanya dari quote + wallet string di [JupiterApiSwapGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/jupiter/JupiterApiSwapGateway.ts:60)
  Status: deferred
  Kenapa ditunda: Batch 16 fokus pada contract-safe HTTP adapters dan error mapping. Quote Jupiter resmi sudah tersambung, tetapi submit swap nyata masih butuh signing/orchestration yang belum ada di repo ini.
  Revisit: saat Batch 16/17 mulai memasang signer/runtime submit flow resmi atau saat real live swap execution menjadi kebutuhan langsung.

- `N41` HTTP adapters saat ini belum punya retry/backoff untuk read path idempotent (`GET` quote/list/pool-info/token intel) di [HttpJsonClient.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/http/HttpJsonClient.ts:1)
  Status: deferred
  Kenapa ditunda: timeout dan typed error mapping sudah cukup untuk Batch 16 correctness, tetapi transient 5xx/read blip masih langsung menggagalkan cycle sekali jalan.
  Revisit: saat worker runtime mulai memakai adapter live secara periodik; putuskan apakah retry di adapter atau di worker orchestration layer.

- `N42` `summarizeText()` di HTTP client memotong error body ke 200 karakter, sehingga structured vendor error bisa kehilangan detail di [HttpJsonClient.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/http/HttpJsonClient.ts:78)
  Status: deferred
  Kenapa ditunda: body ringkas cukup untuk sekarang dan mencegah log/error terlalu bising, tetapi beberapa upstream bisa menyimpan kode error penting di payload yang lebih panjang.
  Revisit: saat real adapter observability mulai dipakai operator dan perlu richer vendor error context.

- `N43` simulation seeding belum idempotent penuh karena `runDryRunSimulation()` masih melakukan append journal fixture tanpa dedup/replace di [runDryRunSimulation.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runDryRunSimulation.ts:69)
  Status: deferred
  Kenapa ditunda: untuk test harness saat ini setiap run memakai temp workspace baru, jadi duplicate seed belum mengganggu correctness. Tetapi jika simulator nanti dipakai di persistent dev environment yang sama, replay fixture yang dijalankan dua kali bisa menggandakan initial journal events.
  Revisit: saat harness mulai dipakai sebagai tooling dev/regression jangka panjang di workspace yang persisten.

- `N44` replay simulation gateway masih belum mencakup `LlmGateway`, `SwapGateway`, `ScreeningGateway`, atau `TokenIntelGateway` di [ReplaySimulationGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/app/simulation/ReplaySimulationGateway.ts:1)
  Status: deferred
  Kenapa ditunda: Batch 17 PRD memang fokus pada lifecycle stop-loss/rebalance/timeout/circuit-breaker, jadi harness sekarang cukup dengan `DlmmGateway` + valuation inputs. Namun advisory AI, post-close swap, screening, dan token-intel path belum bisa direpro lewat replay fixture yang sama.
  Revisit: saat simulator mulai dipakai sebagai regression platform yang lebih luas untuk Batch 18+ atau saat swap/screening/advisory flow perlu skenario replay resmi.

- `T8` coverage gap risk engine setelah hardening Batch 12 di [riskRules.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/riskRules.test.ts:1)
  Status: deferred
  Kenapa ditunda: core semantics Batch 12 sudah diregresikan, tetapi beberapa branch penting dan ambiguity cases belum diuji eksplisit.
  Missing coverage:
  `maxConcurrentPositions` on deploy, `pendingActions` block, `maxRebalancesPerPosition`, `maxNewDeploysPerHour`, rebalance shrink (`allocationDeltaUsd < 0`), pool-same-as-old rebalance projection, circuit breaker `COOLDOWN` pass-through/expiry semantics, recovery of loss back below limit, dan allow-assertion individual untuk `CLAIM_FEES`/`PARTIAL_CLOSE`.
  Revisit: sebelum Batch 13 worker benar-benar mengonsumsi evaluator ini secara langsung.

- `T9` coverage gap management worker/orchestration di [managementWorker.test.ts](c:/Users/PC/Desktop/meridian_v2/tests/unit/managementWorker.test.ts:1)
  Status: deferred
  Kenapa ditunda: Batch 13 sudah punya regression untuk canonical snapshot builder, recent deploy counter, close dispatch, rebalance dispatch di deploy-limit boundary, unsupported action skip, expanded active-capital statuses, dan cooldown entry. Tetapi beberapa branch orchestration belum diuji eksplisit.
  Missing coverage:
  `dryRun`, `BLOCKED_BY_RISK`, `RECONCILE_ONLY`, planner `null`, multiple open positions in one cycle, signalProvider failure boundary, gateway failure propagation, dan journal events untuk unsupported/skipped actions.
  Revisit: sebelum worker orchestration dipakai sebagai loop runtime utama atau mulai dihubungkan ke reporter/operator surface.

- `N48` Darwin recalibration saat ini baru bisa menyesuaikan signal yang memang sudah punya metadata canonical di `PerformanceRecord` (`feeToTvl`, `organicScore`); signal lain masih bertahan di weight default karena histori entry-nya belum dipersist konsisten di [signalWeightRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/signalWeightRules.ts:1)
  Status: deferred
  Kenapa ditunda: Batch 17.4 menutup fondasi entity/store/rule/usecase/provider dan menjaga perubahan scoring tetap deterministic, tetapi belum ada source historis yang bersih untuk `volumeConsistency`, `liquidityDepth`, `holderQuality`, `tokenAuditHealth`, `smartMoney`, `poolMaturity`, `launchpadPenalty`, atau `overlapPenalty`.
  Revisit: saat screening worker / candidate snapshot persistence resmi dibangun, supaya entry snapshot per kandidat bisa ditautkan ke `PerformanceRecord` close dan Darwin bisa belajar dari seluruh sinyal.

- `N49` Darwin weights belum terinjeksi default di runtime screening, tetapi sudah ditutup di Batch 20 karena `createRuntimeSupervisor()` sekarang membuat `DefaultSignalWeightsProvider` dan menyuntikkannya ke `runScreeningWorker()`
  Status: closed
  Kenapa ditutup: jalur runtime screening sekarang sudah memakai provider Darwin secara default saat `darwin.enabled=true`, bukan hanya pada integration/usecase caller manual.

- `N50` runtime supervisor/composition root sekarang sudah ada, tetapi concrete live wiring untuk `WalletGateway`, `PriceGateway`, `NotifierGateway`, dan public wallet source masih bergantung pada environment luar repo ini
  Status: deferred
  Kenapa ditunda: repo inti sekarang sudah menyediakan `createRuntimeStores()` + `createRuntimeSupervisor()`, tetapi belum punya adapter live native untuk semua boundary runtime yang dibutuhkan supervised-live penuh. Tanpa wiring environment itu, supervisor tetap berjalan sebagai composition root yang DI-first, bukan executable live node yang self-contained.
  Revisit: sebelum supervised live run pertama; putuskan source wallet publik, adapter balance/price live, dan notifier delivery nyata.

- `N51` pembacaan journal sekarang hanya mentoleransi malformed trailing line; corruption di tengah file akan melempar `JournalStoreCorruptError` dengan nomor line yang jelas di `JournalRepository.ts`
  Status: closed
  Kenapa ditutup: observability audit sekarang tidak lagi kehilangan line tengah diam-diam; operator akan melihat corruption lebih awal dengan context file + line number.

- `N52` `runManagementCycle()` masih membangun `PortfolioState` penuh per posisi, sehingga IO/gateway cost bertumbuh linear dengan jumlah posisi dan scan journal harian ikut terulang di [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:1) dan [PortfolioStateBuilder.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/PortfolioStateBuilder.ts:1)
  Status: deferred
  Kenapa ditunda: correctness worker saat ini tetap aman, tetapi cycle runtime akan makin mahal saat journal append-only membesar dan posisi aktif bertambah.
  Revisit: sebelum supervised live loop dinaikkan frekuensinya atau jumlah posisi aktif bertambah signifikan; pertimbangkan snapshot sekali per cycle + delta pending action / daily PnL.

- `N53` `HttpJsonClient.request()` belum menormalisasi kegagalan saat membaca `response.text()`, sehingga stream/body read error bisa lolos sebagai error mentah, bukan `AdapterTransportError`, di [HttpJsonClient.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/http/HttpJsonClient.ts:1)
  Status: deferred
  Kenapa ditunda: jalur ini jarang, dan transport error utama sudah tertutup untuk fetch/timeout, tetapi boundary adapter idealnya tetap konsisten menormalkan body-read failure.
  Revisit: saat adapter live mulai sering dipakai terhadap upstream yang lebih noisy.

- `N54` `ActionRepository.upsertByIdempotencyKey()` masih melakukan rewrite file walau hit idempotency tidak mengubah data di [ActionRepository.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/ActionRepository.ts:1)
  Status: deferred
  Kenapa ditunda: correctness tetap aman dan data idempotent, tetapi no-op hit masih membayar atomic write + temp artifact churn yang tidak perlu.
  Revisit: saat profiling I/O repository mulai penting atau idempotent request volume meningkat.

- `N55` race guard `ActionQueue.claimedActionIds` masih hanya in-process; dua proses yang berbagi `dataDir` masih bisa melihat action yang sama sebelum salah satunya menulis barrier status di [ActionQueue.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/ActionQueue.ts:1)
  Status: deferred
  Kenapa ditunda: mode operasi sekarang memang single-process supervised live, jadi belum menjadi blocker praktis. Tetapi guard ini belum cukup bila queue suatu hari dipanggil dari dua proses berbeda.
  Revisit: sebelum multi-process tooling/runtime terhadap `dataDir` yang sama diizinkan.

- `N56` `KeyedLock.withLock()` masih sensitif jika tail promise sebelumnya pernah reject; await chain defensif (`catch(() => undefined)`) belum diterapkan di [KeyedLock.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/locks/KeyedLock.ts:1)
  Status: deferred
  Kenapa ditunda: test/runtime sekarang belum menemukan previous-tail rejection yang merusak chain, tetapi guard tambahan akan membuat lock lebih tahan terhadap future regression.
  Revisit: saat lock primitive disentuh lagi atau sebelum concurrency pressure dinaikkan.

- `N57` `createUlid()` belum memvalidasi timestamp non-finite; input `NaN` bisa menghasilkan ID rusak sebelum schema downstream menolaknya di [createUlid.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/id/createUlid.ts:1)
  Status: deferred
  Kenapa ditunda: caller current path umumnya memakai timestamp valid, jadi ini lebih ke defensive hardening. Namun operator/manual path yang mem-parse timestamp bebas tetap berpotensi memicu ID jelek.
  Revisit: saat operator/manual timestamp surface diperluas atau sebelum ULID helper dipakai lebih luas.

- `N58` semantik `peakPnlPct` setelah `CLAIM_FEES` belum dipilih eksplisit; trailing take-profit sekarang mempertahankan peak lintas claim, padahal claim bisa menggeser basis nilai posisi di [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:1) dan [finalizeClaimFees.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeClaimFees.ts:1)
  Status: deferred
  Kenapa ditunda: ada tradeoff produk yang belum diputuskan apakah peak harus dibaca sebagai "sejak posisi dibuka" atau "sejak claim terakhir". Mengubahnya sekarang akan mengubah perilaku trailing TP yang sudah hidup di Batch 21.
  Revisit: sebelum trailing take-profit dipakai live dengan `CLAIM_FEES` aktif.

- `N59` runtime live semula memakai env bridge statis untuk wallet balance dan harga SOL di `runLive.ts`, tetapi sekarang sudah ditutup dengan `SolanaRpcWalletGateway` + `JupiterSolPriceGateway`
  Status: closed
  Kenapa ditutup: bootstrap live sekarang mengambil wallet balance dari Solana RPC dan harga SOL dari Jupiter quote, jadi risk/reporting tidak lagi bergantung pada mock env bridge.

- `N60` payload ke LLM masih terlalu gemuk karena membawa snapshot posisi mentah yang dapat memuat metadata berlebih di [HttpLlmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/llm/HttpLlmGateway.ts:1)
  Status: deferred
  Kenapa ditunda: advisory layer sudah aman secara write boundary, tetapi minimisasi data outbound ke LLM pihak ketiga belum selesai.
  Revisit: sebelum AI advisory dipakai pada environment live yang lebih sensitif; ringkas prompt ke field yang benar-benar relevan untuk reasoning.

- `N61` screening runtime masih mengunci beberapa caps/candidate knobs di code (`allowedPairTypes`, holder caps, shortlist limit, duplicate exposure flags) di [createRuntimeSupervisor.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/createRuntimeSupervisor.ts:1)
  Status: deferred
  Kenapa ditunda: Batch 20 sudah menutup banyak parity knobs, tetapi beberapa screening cap masih belum user-configurable dan butuh keputusan surface config supaya tidak meledakkan `user-config.json`.
  Revisit: saat ada permintaan parity knob lanjutan atau sebelum operator ingin men-tune screening live tanpa edit source.

- `N62` inbound Telegram operator commands semula belum ada, tetapi sekarang sudah ditutup lewat long-poll operator surface di `runLive.ts`
  Status: closed
  Kenapa ditutup: runtime live sekarang bisa menerima command operator dari Telegram secara configurable (`telegramOperatorCommandsEnabled`) dengan gate `alertChatId`. Webhook mode belum ada, tetapi remote operator control tidak lagi terbatas pada stdin.

- `N63` screening enrichment candidate sekarang tidak lagi berjalan serial; detail pool dan narrative token diproses paralel via `Promise.all` di `runScreeningCycle.ts`
  Status: closed
  Kenapa ditutup: latency screening tidak lagi bertumbuh murni linear karena `getCandidateDetails()` antar-candidate sekarang mulai dieksekusi paralel, dan narrative enrichment juga tidak lagi menunggu detail pool selesai lebih dulu.

- `N64` guard freshness untuk snapshot PnL trailing sekarang sudah ditutup di `runManagementCycle.ts`; peak refresh dan trailing evaluation tidak lagi memakai snapshot yang stale
  Status: closed
  Kenapa ditutup: refresh peak dan firing trailing sekarang mensyaratkan snapshot posisi yang masih fresh (`lastSyncedAt` dalam jendela aman), sehingga kombinasi `currentValueUsd` / `unrealizedPnlUsd` yang stale tidak lagi bisa mengangkat peak atau memicu close palsu.

- `N65` adaptive screening interval saat ini membaca window `start === end` sebagai match selalu, bukan no-op, di [AdaptiveScreeningInterval.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AdaptiveScreeningInterval.ts:1)
  Status: deferred
  Kenapa ditunda: edge case ini tidak umum jika config benar, tetapi semantics-nya tidak intuitif dan pantas dikunci lewat validation atau dokumentasi eksplisit.
  Revisit: saat config scheduler/screening disentuh lagi atau sebelum adaptive interval dipakai lebih luas lintas timezone.

- `N66` opsi `reporting.briefingEmoji` masih bernama seolah menghasilkan emoji, padahal formatter sekarang memakai label teks pendek, di [renderDailyBriefing.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/renderDailyBriefing.ts:1)
  Status: deferred
  Kenapa ditunda: ini lebih ke naming/UX mismatch, bukan correctness bug.
  Revisit: saat template briefing/reporting disentuh lagi; pilih antara rename flag atau benar-benar render emoji saat enabled.

- `N67` `ActionTypeSchema` masih membawa enum future/dead path seperti `SWAP`, `SYNC`, `CANCEL_REBALANCE`, dan `PARTIAL_CLOSE` tanpa lifecycle/runtime penuh di [enums.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/types/enums.ts:1)
  Status: deferred
  Kenapa ditunda: tidak merusak runtime saat ini, tetapi memperlebar surface enum dan bisa membingungkan konsumer baru tentang fitur yang benar-benar didukung.
  Revisit: saat cleanup lifecycle berikutnya; putuskan apakah enum itu segera dihidupkan atau dibuang dari surface publik.

- `N68` nama path `lessonsFilePath` sekarang misleading karena file gabungan menyimpan `lessons` sekaligus `performance`, bukan lessons saja, di [createRuntimeStores.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/createRuntimeStores.ts:1)
  Status: deferred
  Kenapa ditunda: ini naming/ergonomics issue, bukan data-integrity bug, karena shared schema file tetap konsisten dan aman dipakai sekarang.
  Revisit: saat knowledge/performance storage disentuh lagi; pilih rename ke nama yang lebih netral atau split file bila manfaatnya jelas.

- `N69` `JournalEvent.resultStatus` masih free-form string sehingga operator/manual events menambah entropy nilai status di journal, di [operatorCommands.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/operatorCommands.ts:1)
  Status: deferred
  Kenapa ditunda: downstream parser internal saat ini belum mengandalkan enum sempit untuk seluruh journal, tetapi permissive string akan makin mahal dirapikan jika event surface terus bertambah.
  Revisit: saat format journal/reporting distabilkan untuk tooling operator atau ekspor analytics.

## Design Decisions

- Batch 21 memilih `claim succeeded, compound failed` sebagai outcome yang sah; kegagalan swap/enqueue deploy tidak membatalkan finalisasi claim yang sudah confirmed on-chain
  Rationale: setelah claim on-chain confirmed, mencoba memaksa seluruh action menjadi `FAILED` justru mengaburkan fakta bahwa fee sebenarnya sudah berhasil diklaim. V2 lebih memilih claim ditutup `DONE` dengan metadata compound `FAILED` atau `MANUAL_REVIEW_REQUIRED`, lalu follow-up compound ditangani terpisah.
  Tradeoff: operator harus membaca result payload/journal untuk tahu bahwa claim selesai tetapi compound tidak ikut selesai, karena status action induk sendiri tetap `DONE`.

- Batch 17.2 menstandarkan naming screening threshold ke istilah PRD yang baru: `minFeeActiveTvlRatio` dan `minOrganic`
  Rationale: spec 17.2 dan heuristik repo lama memakai istilah itu secara eksplisit; menyelaraskan naming sekarang lebih murah daripada membawa alias lama (`minFeeToTvlRatio` / `minOrganicScore`) ke runtime policy store dan evolution layer.
  Tradeoff: config fixture, tests, dan operator docs harus ikut bergerak ke naming baru, tetapi surface screening menjadi lebih konsisten dengan PRD 17.2+.

- Runtime overrides screening disimpan terpisah di `policy-overrides.json`, bukan memutasi `user-config.json`
  Rationale: base config tetap immutable dan audit-friendly, sementara hasil evolution adalah state runtime yang bisa di-reset tanpa menyentuh source config operator.
  Tradeoff: caller sekarang harus melewati `PolicyProvider` jika ingin screening policy final; membaca config base saja tidak lagi cukup untuk mencerminkan policy aktif.

- Batch 17.1 menyimpan `lessons` dan `performance` dalam satu file shared `lessons.json`, bukan dua store terpisah
  Rationale: ini mengikuti spec Batch 17.1 agar snapshot memory + performance selalu konsisten dan migrasi dari repo lama lebih mudah.
  Tradeoff: file ini sekarang memegang dua concern yang berbeda, sehingga corruption/backup handling perlu lebih hati-hati dan memang sengaja dibiarkan jadi concern Batch 18 jika store rusak.

- AI advisory tidak boleh memanggil LLM tanpa hasil konsultasi lesson; jika `LessonPromptService` gagal, sistem harus log `ai_lesson_injection_failed` lalu fallback ke deterministic
  Rationale: PRD Batch 17.1 menegaskan bahwa AI harus belajar dulu sebelum entry/management reasoning. Safety yang dipilih adalah “no lessons -> no LLM”, bukan “LLM jalan tanpa konteks”.
  Tradeoff: jika lesson store unavailable, kualitas advisory turun ke deterministic penuh sampai store pulih, tetapi boundary keselamatan dan auditability tetap jelas.

- Batch 17.4 memperlakukan `signalWeights` sebagai multiplier di atas `scoringPolicy.weights`, bukan mengganti policy base weight mentah, di [candidateScore.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/scoring/candidateScore.ts:1)
  Rationale: policy base tetap source of truth yang bisa diaudit operator, sementara Darwin menjadi lapisan adaptif kecil yang menggeser sensitivitas scorer secara perlahan.
  Tradeoff: perubahan Darwin tidak pernah benar-benar meniadakan policy weight dasar; jika operator ingin mematikan atau merombak sebuah signal total, itu tetap dilakukan di config/policy, bukan menunggu Darwin.

- Batch 18 memakai satu scheduler metadata store bersama untuk trigger `cron`, `manual`, dan `startup`, di [SchedulerMetadataStore.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/scheduler/SchedulerMetadataStore.ts:1) dan [runWithSchedulerMetadata.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/scheduler/runWithSchedulerMetadata.ts:1)
  Rationale: PRD meminta countdown/timer dan manual trigger berbagi state yang sama agar tidak terjadi double-fire liar. Menyimpan metadata run bersama memberi satu sumber kebenaran untuk health/reporting sekaligus guard sederhana saat worker sudah `RUNNING`.
  Tradeoff: scheduler metadata sekarang menjadi state runtime tambahan yang juga harus dijaga dari corruption dan diinjeksikan oleh composition root nyata; tanpa wiring runtime itu, fitur ini tetap opsional di level caller.

- Simulation harness Batch 17 sengaja menjalankan urutan cycle `reconcile -> manage -> queue` di [runDryRunSimulation.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runDryRunSimulation.ts:1)
  Rationale: replay fixture jadi lebih deterministik karena action yang disubmit pada cycle N baru dikonfirmasi atau di-recover pada cycle N+1, sesuai model worker periodik yang lebih realistis.
  Tradeoff: skenario yang ingin "submit dan confirm di cycle yang sama" harus dimodelkan sebagai dua step replay, bukan satu step tunggal.

- Deploy request tetap menulis via `ActionQueue`; `requestDeploy()` tidak boleh direct write ke state/action terminal.
  Rationale: single-writer principle.
  Files: [requestDeploy.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestDeploy.ts:1), [ActionQueue.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/ActionQueue.ts:1)

- Pending deploy position baru dimaterialisasi setelah `deployLiquidity()` sukses dan `positionId` canonical sudah diketahui.
  Rationale: hindari placeholder position palsu sebelum submit gateway benar-benar berhasil.
  Tradeoff: sebelum submit sukses, belum ada row position lokal untuk deploy tersebut.
  Files: [processDeployAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1)

- Confirm deploy memakai `DlmmGateway.getPosition(positionId)` sebagai confirmation check untuk Batch 6.
  Rationale: cukup untuk mock/integration sekarang.
  Tradeoff: real adapter nanti mungkin perlu signal yang lebih kuat daripada sekadar object exists.
  Revisit: saat Batch 16 real adapter.

- Jika submit on-chain sukses tetapi persist lokal gagal, flow dipaksa tetap recoverable lewat `WAITING_CONFIRMATION` + `RECONCILIATION_REQUIRED`, bukan dijatuhkan ke `FAILED`.
  Rationale: lebih aman punya action recoverable daripada orphan on-chain position tanpa jejak lokal yang bisa di-follow-up.
  Files: [processDeployAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1)

- Prioritas implementasi saat ini: patch correctness/safety dulu, cleanup dan ergonomics setelah fondasi lifecycle stabil.
  Rationale: proyek masih di fase greenfield lifecycle, jadi debt management harus ketat terhadap hal yang benar-benar berisiko ke production.

- Idempotency close saat ini diturunkan dari `{ wallet, type, positionId, reason }` tanpa komponen waktu/nonce di [requestClose.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestClose.ts:77)
  Rationale: untuk sekarang close request dengan payload identik dianggap duplicate intent dan harus ditahan oleh idempotency guard.
  Tradeoff: dua request operator terpisah dengan reason yang sama akan collide.
  Revisit: saat Batch 14 operator interface/CLI mulai butuh explicit retry or override semantics.

- Reconciliation worker memproses `WAITING_CONFIRMATION` lebih dulu baru missing snapshot di [reconcilePortfolio.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:239)
  Rationale: jika wallet snapshot lagging, action deploy/close yang sebenarnya masih recoverable tidak boleh keburu dipaksa ke jalur missing-snapshot lebih kasar.
  Tradeoff: snapshot drift detection sengaja sedikit ditunda demi memberi ruang recovery action yang lebih deterministik.

- Startup recovery untuk action yang tertinggal di `RECONCILING` bersifat konservatif di [reconcilePortfolio.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:141)
  Rationale: Batch 8 belum punya resumption logic granular untuk melanjutkan finalizer dari tengah; lebih aman menurunkannya ke `FAILED` + `RECONCILIATION_REQUIRED`.
  Tradeoff: recovery tidak mencoba resume in-place, jadi follow-up tetap bergantung pada reconciliation/manual review berikutnya.

- Management engine menempatkan `RECONCILE_ONLY` setelah hard-exit tetapi sebelum maintenance di [managementRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/managementRules.ts:175)
  Rationale: jika snapshot belum layak untuk maintenance decision, engine harus menahan claim/partial-close/rebalance, tetapi emergency dan hard-exit tetap boleh menang lebih dulu.
  Tradeoff: maintenance opportunity yang valid bisa sengaja ditunda satu cycle demi menjaga deterministic safety.

- Screening pipeline memaksa hard filter selesai sebelum scoring/shortlist di [screeningRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/screeningRules.ts:74)
  Rationale: kandidat yang gagal hard filter tidak boleh masuk ranking atau shortlist deterministic, sehingga AI layer nanti hanya bekerja pada kandidat yang memang sudah lolos boundary safety.
  Tradeoff: candidate dengan skor potensial bagus tetap dibuang total jika gagal filter keras, walau margin gagalnya tipis.

- Rebalance resmi dipertahankan sebagai satu action `REBALANCE` dengan phase eksplisit di `resultPayload`, bukan dipecah menjadi action `CLOSE` + `DEPLOY` terpisah di queue.
  Rationale: satu action memudahkan idempotency, observability, dan recovery path untuk dua leg yang secara bisnis adalah satu intent rebalance.
  Tradeoff: action bisa tetap berada di `WAITING_CONFIRMATION` sambil `resultPayload.phase` berubah dari `CLOSE_SUBMITTED` ke `REDEPLOY_SUBMITTED`, sehingga consumer harus membaca phase payload, bukan hanya status action.
  Files: [processRebalanceAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processRebalanceAction.ts:1), [finalizeRebalance.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeRebalance.ts:1)

- Drawdown warning di risk engine sekarang mulai menyala pada 50% dari `dailyLossLimitPct` di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:177)
  Rationale: memberi sinyal lebih dini sebelum limit penuh tercapai, tanpa harus menunggu circuit breaker menyala.
  Tradeoff: threshold warning ini adalah pilihan desain internal, belum datang eksplisit dari PRD; jika operator nanti butuh sensitivitas berbeda, kemungkinan perlu dinaikkan ke config.

- Portfolio risk engine sekarang memakai konvensi unit USD-equivalent untuk reserve guard (`minReserveUsd`) di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:19) dan [configSchema.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/config/configSchema.ts:25)
  Rationale: evaluator risk sudah membandingkan allocation, capital usage, realized PnL, dan exposure terhadap snapshot nilai yang sama; menyamakan reserve ke unit yang sama menghindari drift SOL-vs-USD di boundary.
  Tradeoff: nama ini sekarang menyimpang dari wording PRD lama (`minReserveSol`), sehingga integrasi/operator docs harus mengikuti naming baru.

- Threshold `max` pada capital usage dan exposure di risk engine sekarang diperlakukan inclusive (`>=`) di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:461)
  Rationale: untuk guardrail risk, “menyentuh limit” dianggap sudah tidak aman untuk ekspansi posisi baru.
  Tradeoff: perilaku ini lebih konservatif daripada interpretasi exclusive-cap.

- `REBALANCE` tidak dihitung sebagai `maxNewDeploysPerHour` di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:497) (resolves `N27`)
  Rationale: limit hourly-new-deploys bertujuan menahan ekspansi eksposur baru (posisi baru, capital committed baru); rebalance hanya menggeser range posisi yang sudah ada dan sudah punya guard terpisah `maxRebalancesPerPosition`. Menghitungnya berarti double-regulate dan bisa memblok reposisi sah di market volatil.
  Tradeoff: jika nanti operator ingin rate-limit total on-chain write (termasuk rebalance), perlu limit baru yang terpisah dari `maxNewDeploysPerHour`.

- Unit bridge SOL↔USD dikerjakan di boundary worker lewat `PriceGateway` (konversi sekali di entry Batch 13), bukan disimpan sebagai rate di `PortfolioState` (resolves `N31`)
  Rationale: harga = dependency eksternal yang berubah cepat, natural diletakkan sebagai adapter port. Menaruh rate di `PortfolioState` akan mencampur "apa isi portfolio" dengan "dengan rate berapa kita menilainya", dan membuat snapshot basi ketika rate berubah. Risk engine tetap pure USD tanpa perlu tahu soal konversi.
  Tradeoff: tiap worker yang menyuplai snapshot ke evaluator wajib melewati `PriceGateway` terlebih dulu.
  Implementation note: Batch 13 sudah memperkenalkan `PriceGateway` port + adapter mock, dan `PortfolioState` builder sekarang memakainya untuk memproduksi semua nilai USD-equivalent sebelum evaluator dipanggil.

- Management worker Batch 13 sengaja me-rebuild portfolio snapshot per posisi, bukan sekali per cycle, di [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:117)
  Rationale: setelah satu posisi men-dispatch write action, iterasi berikutnya harus melihat `pendingActions` terbaru agar deterministic safety tetap menang. Ini membuat worker efektif hanya akan mengizinkan satu write action baru per cycle per wallet.
  Tradeoff: IO jadi lebih mahal dan behavior “satu write per cycle” harus dipahami sebagai desain worker saat ini, bukan side-effect tak sengaja.

- Canonical operator config untuk `maxRebalancesPerPosition` sekarang ada di `risk.maxRebalancesPerPosition`; `management` config tidak lagi meminta field yang sama di [configSchema.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/config/configSchema.ts:21)
  Rationale: hindari dua source of truth di file config operator.
  Tradeoff: pure `managementRules` domain schema masih memakai field itu secara internal, jadi caller non-config tetap harus memberi value saat memanggil engine langsung.

- `dailyRealizedPnl` canonical untuk worker Batch 13 sekarang diturunkan dari delta `before/after.realizedPnlUsd` pada journal event harian, bukan dari snapshot posisi `closedAt` semata di [PortfolioStateBuilder.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/PortfolioStateBuilder.ts:51)
  Rationale: pendekatan ini lebih aman untuk partial close, close bertahap, dan posisi yang membawa realized PnL historis dari hari sebelumnya.
  Tradeoff: akurasi harian sekarang bergantung pada journal position-delta yang lengkap; caller yang membangun portfolio snapshot tanpa journal repository tidak lagi didukung.

- Lifecycle circuit breaker worker sekarang mengandalkan snapshot portfolio sebelumnya yang dibawa antar-cycle, termasuk timestamp `circuitBreakerActivatedAt` dan `circuitBreakerCooldownStartedAt`, di [PortfolioStateBuilder.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/PortfolioStateBuilder.ts:83) dan [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:81)
  Rationale: ini memberi transisi penuh `ON -> COOLDOWN -> OFF` tanpa mencampur concern breaker lifecycle ke risk engine pure.
  Tradeoff: persistence lintas restart proses tetap menjadi tanggung jawab scheduler/worker runtime saat surface itu dibangun lebih lanjut.

- CLI dan Telegram operator surfaces Batch 14 berbagi parser/executor yang sama, dan manual command hanya boleh memanggil request use case yang masuk queue (`requestClose`, `requestDeploy`, `requestRebalance`) di [operatorCommands.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/operatorCommands.ts:1)
  Rationale: ini menjaga DoD Batch 14 tetap tegas; surface operator boleh membaca state dan membuat request, tetapi tidak boleh bypass single-writer boundary.
  Tradeoff: format output saat ini masih text-first dan sengaja sederhana; jika nanti operator butuh UX lebih kaya, enhancement harus tetap duduk di atas parser/executor yang sama.

- Batch 19 manual panic control disimpan di runtime control store terpisah (`runtime-controls.json`), bukan memaksa mutate `PortfolioState.circuitBreakerState` atau policy override screening/risk di [RuntimeControlStore.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/storage/RuntimeControlStore.ts:1)
  Rationale: manual "stop all deploys/rebalances" adalah intent operator runtime, bukan observasi risk snapshot. Menyimpannya terpisah menghindari tabrakan semantik dengan circuit breaker otomatis yang tetap diturunkan dari risk engine/portfolio snapshot.
  Tradeoff: caller runtime yang ingin menghormati panic button wajib membaca runtime control store eksplisit; saat ini `runManagementCycle()` dan operator deploy/rebalance sudah melakukannya, tetapi screening worker nanti juga harus ikut wiring yang sama.

- Batch 15 mempertahankan AI sebagai advisory layer; bahkan pada mode `constrained_action`, management worker tetap mengeksekusi hasil deterministic dan hanya membawa metadata AI (`aiSuggestedAction`, `aiReasoning`, `aiSource`) di [AiAdvisoryService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AiAdvisoryService.ts:1) dan [runManagementCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runManagementCycle.ts:1)
  Rationale: prinsip produk tetap “AI advisory unless explicitly allowed”; Batch 15 menambah ranking/explanation terstruktur tanpa membuka write privilege atau memberi override langsung ke lifecycle inti.
  Tradeoff: mode `constrained_action` saat ini baru membatasi bentuk saran AI, belum menjadi sumber aksi final. Override action baru layak dipertimbangkan setelah supervised/live governance lebih matang.

- Batch 16 memakai pola “HTTP adapter + composition root”, bukan instantiate live service langsung dari worker. Adapter nyata tersedia di [HttpDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/HttpDlmmGateway.ts:1), [JupiterApiSwapGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/jupiter/JupiterApiSwapGateway.ts:1), [HttpScreeningGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/screening/HttpScreeningGateway.ts:1), dan [HttpTokenIntelGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/analytics/HttpTokenIntelGateway.ts:1)
  Rationale: domain/worker layer tetap bergantung pada interface, sementara pemilihan service live, base URL, key, dan execution bridge menjadi tanggung jawab composition root atau runtime supervisor.
  Tradeoff: “real adapter available” tidak sama dengan “runtime default sudah live”; wiring ke service nyata tetap langkah terpisah.

- Batch 17.3 memilih `volume_collapse` sebagai default trigger cooldown pool, bukan `low_yield` seperti di spec literal, di [poolMemoryRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/poolMemoryRules.ts:48)
  Rationale: `CloseReasonSchema` V2 hanya berisi enum `manual | stop_loss | take_profit | out_of_range | volume_collapse | timeout | operator` — tidak ada `low_yield`. Spec Batch 17.3 sendiri memberi escape hatch eksplisit: “`"low_yield"` bila ada; atau kriteria lain yang lebih jelas”. `volume_collapse` memenuhi semangat repo lama (`close_reason === "low yield"` = pool tidak lagi profitable) tanpa memaksa menambah enum baru yang belum punya produsen di lifecycle V2.
  Tradeoff: `shouldCooldown()` default hanya menyalakan cooldown saat volume collapse; operator yang ingin kriteria tambahan (mis. loser cepat dengan `pnlPct < 0 && minutesHeld < N`) harus memberi `closeReasonSet` atau memperluas rule secara eksplisit.
  Files: [poolMemoryRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/poolMemoryRules.ts:44), [recordPoolDeploy.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/recordPoolDeploy.ts:1)

- Batch 17.3 menegakkan bahwa `rankShortlistWithAi` WAJIB membawa `includePoolMemory` ke `LessonPromptService`, dan `DefaultLessonPromptService` tidak boleh lagi return `null` hanya karena lesson kosong bila pool memory diminta di [LessonPromptService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/LessonPromptService.ts:1) dan [AiAdvisoryService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AiAdvisoryService.ts:1)
  Rationale: spec Batch 17.3 menetapkan pool memory sebagai injection mandatory kedua setelah lessons. Kalau fresh install punya pool-memory tapi belum punya lessons, AI harus tetap melihat konteks pool-nya — tidak boleh jatuh ke LLM tanpa konteks sama sekali.
  Tradeoff: header `### LESSONS LEARNED` yang dibungkuskan `AiAdvisoryService` sekarang bisa membawa konten yang hanya berisi blok `### POOL MEMORY`; header itu berfungsi sebagai wrapper “context block”, bukan label literal lessons. Jika nanti ingin header lebih jujur, perlu refactor terpisah di AiAdvisoryService agar memisahkan kedua blok.
  Files: [LessonPromptService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/LessonPromptService.ts:32), [AiAdvisoryService.ts](c:/Users/PC/Desktop/meridian_v2/src/app/services/AiAdvisoryService.ts:192)

## Closed

- `N70` Batch 25 explicit pre-close redeploy simulation gateway contract
  Status: closed
  Kenapa ditutup: `DlmmGateway` sekarang memiliki `simulateClosePosition()` dan `simulateDeployLiquidity()`. Native Meteora SDK gateway membangun transaksi close/remove dan redeploy lalu menjalankan simulation tanpa submit; `runManagementCycle()` menjalankan kedua simulasi sebelum action `REBALANCE` masuk queue saat `requireRebalanceSimulation=true`.

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
- `N32` canonical `PortfolioState` builder sekarang ada di `PortfolioStateBuilder`, memakai `WalletGateway` + `PriceGateway` untuk membangun snapshot USD-equivalent yang konsisten.
- `N33` sumber `recentNewDeploys` sekarang dibakukan lewat helper `countRecentNewDeploys()` yang menghitung action `DEPLOY` non-terminal/valid dalam window 1 jam.
- `N34a` active capital snapshot sekarang memasukkan status in-flight/reconciliation penting (`DEPLOYING`, `REDEPLOY*`, `RECONCILIATION_REQUIRED`, `RECONCILING`) sehingga capital/exposure tidak lagi invisible saat posisi stuck.
- `N34b` builder sekarang bisa memasuki `COOLDOWN` ketika snapshot sebelumnya `ON/COOLDOWN` dan loss harian turun di bawah limit; problem yang tersisa tinggal expiry/persistence lifecycle penuh.
- `N34c` close path di management worker tidak lagi menjalankan risk check yang dead untuk action `CLOSE`.
- `N34d` duplicate operator config `maxRebalancesPerPosition` sudah dikurangi; field canonical sekarang hanya ada di section `risk`.
- `N24` circuit breaker lifecycle worker sekarang lengkap sampai `COOLDOWN -> OFF` melalui snapshot state + cooldown timestamp.
- `N35` `dailyRealizedPnl` worker sekarang dihitung dari journal realized-PnL delta harian, sehingga tidak lagi mengandalkan `closedAt` snapshot yang rawan under/overcount.
- `N45` close performance metadata sekarang dibawa lewat `entryMetadata` pada payload deploy/redeploy -> posisi -> `buildPerformanceRecordFromClose()`, sehingga field seperti `poolName`, `binStep`, `volatility`, `feeTvlRatio`, `organicScore`, dan `amountSol` tidak lagi hardcoded placeholder saat metadata entry tersedia.
- `N46` `maybeEvolvePolicy()` sekarang sudah di-wire otomatis dari `createRecordPositionPerformanceLessonHook()`, sehingga close finalization yang berhasil bisa langsung memicu evolusi policy setelah performance tercatat.
- `N47` `recordPoolSnapshot()` sekarang sudah di-wire ke `runManagementCycle()` secara opt-in lewat `poolMemorySnapshotsEnabled` + `poolMemoryRepository`, sehingga snapshot pool bisa direkam selama management cycle aktif.
- `F9` confirmation/finalization recovery sekarang bisa melanjutkan commit yang sudah setengah selesai tanpa menjatuhkan posisi sehat ke `RECONCILIATION_REQUIRED`; deploy, close, dan rebalance redeploy leg sekarang punya resume path saat posisi final lokal sudah ter-commit tetapi action belum sempat ditutup.
- `F10` close performance reconstruction sekarang memakai snapshot posisi pre-close (`performanceSnapshotPosition`) sehingga `initialValueUsd`, `finalValueUsd`, dan `pnlPct` tidak lagi dihitung dari posisi lokal yang sudah di-zero-kan saat `CLOSED`.
- `F11` startup recovery checklist sekarang otomatis menurunkan stale scheduler worker state `RUNNING` menjadi `FAILED` dengan error recovery, sehingga crash sebelumnya tidak membuat worker deadlock permanen.
- `F12` manual circuit breaker sekarang menghormati rebalance end-to-end: request manual, queued close leg, dan redeploy leg finalizer sama-sama diblok di [requestRebalance.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestRebalance.ts:1), [processRebalanceAction.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processRebalanceAction.ts:1), dan [finalizeRebalance.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeRebalance.ts:1).
- `F13` risk engine sekarang memblok konservatif saat `maxDailyLossSol` diset tetapi `solPriceUsd` tidak tersedia, dan helper state harian juga ikut menghormati ambang SOL di [riskRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/riskRules.ts:1).
- `F14` screening cycle sekarang memakai risk policy runtime nyata saat membangun snapshot portfolio, bukan dummy reserve/loss/cooldown constants di [runScreeningCycle.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/runScreeningCycle.ts:1).
- `F15` trailing take-profit sekarang tervalidasi ketat; ketika enabled, `trailingTriggerPct` dan `trailingDropPct` wajib > 0 di [managementRules.ts](c:/Users/PC/Desktop/meridian_v2/src/domain/rules/managementRules.ts:1) dan [configSchema.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/config/configSchema.ts:1).
- `F16` token bot Telegram tidak lagi disimpan sebagai bagian dari base URL adapter; `HttpTelegramNotifierGateway` sekarang membangun path request per call sehingga token tidak menempel di client base URL internal di [HttpTelegramNotifierGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/telegram/HttpTelegramNotifierGateway.ts:1).
- `F17` live runtime sekarang punya operator stdin loop yang configurable, sehingga handler CLI/operator tidak lagi unreachable dari proses `runLive.ts` sendiri di [runLive.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/runLive.ts:1).
- `F18` reporting worker sekarang mengirim alert secara best-effort per item; satu failure delivery tidak lagi menggagalkan seluruh reporting tick di [reportingWorker.ts](c:/Users/PC/Desktop/meridian_v2/src/app/workers/reportingWorker.ts:1).
- `F19` reconciliation, management, dan reporting timers di live runtime sekarang punya in-process overlap guard seperti action queue, sehingga tick lambat tidak menumpuk liar di [runLive.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/runLive.ts:1).
- `F20` screening worker `SKIPPED_ALREADY_RUNNING` tidak lagi mengembalikan timeframe hardcoded; worker sekarang mereport timeframe policy aktual saat skip di [screeningWorker.ts](c:/Users/PC/Desktop/meridian_v2/src/app/workers/screeningWorker.ts:1).
- `F21` Meteora native deploy tidak lagi memakai slippage hardcoded 1000 bps; gateway sekarang menerima `slippageBps` per request dan default runtime `deploy.slippageBps` yang lebih konservatif di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1) dan [configSchema.ts](c:/Users/PC/Desktop/meridian_v2/src/infra/config/configSchema.ts:1).
- `F22` fallback SDK di `listPositionsForWallet()` tidak lagi mengisi mint placeholder `tokenX:pool` / `tokenY:pool`; gateway sekarang membaca mint/range nyata dari pool dan posisi SDK di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F23` close / partial-close Meteora sekarang fail-fast jika snapshot range posisi tidak bisa dibaca; gateway tidak lagi mencoba operasi write dengan range fabricated `-887272..887272` di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F24` claim-before-close di gateway Meteora tidak lagi silent swallow; hasil `closePosition()` sekarang membawa `preCloseFeesClaimed` dan `preCloseFeesClaimError` untuk observability/accounting di [DlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/DlmmGateway.ts:1) dan [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F25` read path Meteora data API sekarang lewat `JsonHttpClient` dengan timeout dan typed adapter errors; fallback ke SDK hanya terjadi pada kegagalan data API yang nyata, bukan lewat `fetch` raw tanpa timeout di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F26` konversi amount token ke lamports di gateway Meteora sekarang memakai pipeline decimal-string + `BigInt` dan cache decimals per mint, jadi tidak lagi bergantung pada `Math.floor(amount * 10 ** decimals)` yang rawan precision loss / overflow halus di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F27` gateway Meteora sekarang mensimulasikan transaksi sebelum submit; simulation failure akan menghentikan send lebih awal dengan error yang lebih jelas di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F28` decoder `WALLET_PRIVATE_KEY` sekarang memverifikasi hasil decode harus 64 bytes, sehingga format JSON array / bs58 yang salah gagal dengan pesan eksplisit sebelum mencapai `Keypair.fromSecretKey()` di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F29` repeated dynamic import `@meteora-ag/dlmm` di hot path sekarang dikonsolidasikan ke helper internal `sdk()`, sehingga caching module dan akses `StrategyType` / discovery positions lebih konsisten di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F30` gateway Meteora sekarang retry submit transaksi untuk transient RPC/send errors seperti `Blockhash not found`, timeout confirmation, dan throttling, sehingga write path tidak lagi gagal terlalu mudah pada blip RPC sesaat di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F31` cache ephemeral `recentDeploys`, `poolByPositionId`, dan `claimedBaseByPositionId` di gateway Meteora sekarang punya TTL prune sehingga runtime panjang tidak menahan entry selamanya di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F32` hasil `claimFees()` sekarang membawa `claimedBaseAmountSource`, dan finalizer claim akan menandai auto-swap/auto-compound gagal secara eksplisit bila amount tidak bisa diestimasi, alih-alih diam-diam melanjutkan dengan angka `0`, di [DlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/DlmmGateway.ts:1), [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1), dan [finalizeClaimFees.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/finalizeClaimFees.ts:1).
- `F33` `claimFees()` Meteora sekarang memprioritaskan parsed post-transaction token balance delta (`claimedBaseAmountSource="post_tx"`) untuk `claimedBaseAmount`, sehingga auto-swap/auto-compound memakai angka aktual dari receipt bila tersedia sebelum fallback ke cache/PnL estimate/unavailable di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F34` compatibility patch `@coral-xyz/anchor` / `@meteora-ag/dlmm` dari repo lama sekarang ikut tersedia sebagai `scripts/patch-anchor.js` dan dijalankan via `postinstall`; native Meteora SDK import sudah diverifikasi berhasil tanpa `DLMM_API_BASE_URL` wrapper di Node ESM runtime.
- `F35` action queue runtime sekarang short-circuit saat `runtime.dryRun=true`, sehingga action manual/queued tidak bisa menembus ke `processDeployAction` / `processCloseAction` / `processClaimFeesAction` / `processRebalanceAction` selama dry-run.
- `F36` `runLive.ts` sekarang merge nilai `.env` ke bootstrap env sebelum parse, jadi `PUBLIC_WALLET_ADDRESS`, `DLMM_API_BASE_URL`, `METEORA_DLMM_DATA_API_BASE_URL`, dan interval env bisa dipakai dari file `.env` tanpa harus diexport manual ke shell.
- `F37` reconciliation recovery sekarang menghormati `runtime.dryRun=true`; action yang stuck di `WAITING_CONFIRMATION` / `RECONCILING` hanya dilaporkan sebagai `REQUIRES_RETRY`, tidak memanggil finalizer/confirm handler yang bisa menulis on-chain di [reconcilePortfolio.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:1).
- `F38` native Meteora gateway sekarang fail-fast bila `PUBLIC_WALLET_ADDRESS` tidak cocok dengan public key hasil decode `WALLET_PRIVATE_KEY`, sehingga dry-run/live tidak bisa diam-diam berjalan memakai signer wallet yang berbeda di [MeteoraSdkDlmmGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/dlmm/MeteoraSdkDlmmGateway.ts:1).
- `F39` reconciliation snapshot sekarang menyinkronkan posisi lokal `OPEN` / `HOLD` / `MANAGEMENT_REVIEW` dari live DLMM wallet snapshot sebelum management membaca state, sehingga PnL/range/bin tidak stale saat posisi sudah ada on-chain di [reconcilePortfolio.ts](c:/Users/PC/Desktop/meridian_v2/src/app/usecases/reconcilePortfolio.ts:1).
- `F40` autonomous deploy dari screening shortlist sekarang tersedia lewat `deploy.autoDeployFromShortlist`; runtime hanya meng-enqueue `DEPLOY` resmi via `requestDeploy()` setelah shortlist lolos, active bin/range di-resolve dari DLMM gateway, pending action/risk/circuit-breaker guard dicek, dan `runtime.dryRun=true` hanya mencatat rencana tanpa enqueue di [createRuntimeSupervisor.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/createRuntimeSupervisor.ts:1).
- `F41` screening live sekarang punya adapter native Meteora Pool Discovery; bila `SCREENING_API_BASE_URL` kosong, `runLive.ts` memakai `https://pool-discovery-api.datapi.meteora.ag` langsung, membawa `timeframe` ke query, memetakan pool discovery ke candidate V2, lalu tetap melewatkan semua keputusan ke hard-filter/scoring engine di [MeteoraPoolDiscoveryScreeningGateway.ts](c:/Users/PC/Desktop/meridian_v2/src/adapters/screening/MeteoraPoolDiscoveryScreeningGateway.ts:1) dan [runLive.ts](c:/Users/PC/Desktop/meridian_v2/src/runtime/runLive.ts:1).

## Next Review Gate

- Review file ini sebelum mulai Batch 7.
- Review lagi sebelum Batch 16 untuk semua item yang menyentuh real adapter boundary.
- Review terakhir sebelum Batch 18/live-readiness untuk memastikan tidak ada deferred item yang ternyata masih high-impact.
