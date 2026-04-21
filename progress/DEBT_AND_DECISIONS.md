# Meridian V2 Debt And Decisions

Last updated: 2026-04-21 (N15/T4 added)
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

- `F5` duplicate `DEPLOY_REQUEST_ACCEPTED` journal di [requestDeploy.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/requestDeploy.ts:1>)
  Status: deferred
  Kenapa ditunda: lebih ke keputusan audit semantics daripada correctness bug.
  Revisit: saat operator/reporting mulai membaca journal untuk counting request volume vs unique action volume.

- `F6` double event `DEPLOY_SUBMISSION_FAILED` + `ACTION_FAILED`
  Status: deferred
  Kenapa ditunda: redundant, tapi tidak merusak state.
  Revisit: saat format observability/journal sudah distabilkan, mungkin Batch 13 atau 18.

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

## Next Review Gate
- Review file ini sebelum mulai Batch 7.
- Review lagi sebelum Batch 16 untuk semua item yang menyentuh real adapter boundary.
- Review terakhir sebelum Batch 18/live-readiness untuk memastikan tidak ada deferred item yang ternyata masih high-impact.
