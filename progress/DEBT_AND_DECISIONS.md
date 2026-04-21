# Meridian V2 Debt And Decisions

Last updated: 2026-04-21
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

- `N5` cross-validation `Action.positionId` vs `Action.type` di [Action.ts](<c:/Users/PC/Desktop/meridian_v2/src/domain/entities/Action.ts:1>)
  Status: deferred
  Kenapa ditunda: sekarang masih bisa ditangkap di use case layer; belum memblokir deploy flow.
  Revisit: sebelum close/rebalance/claim flow makin banyak, idealnya di Batch 7 atau 8.

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

- `N11` `outOfRangeSince` belum di-set saat deploy langsung out-of-range di [processDeployAction.ts](<c:/Users/PC/Desktop/meridian_v2/src/app/usecases/processDeployAction.ts:1>)
  Status: deferred
  Kenapa ditunda: semantik audit kurang akurat, tapi kasus deploy normal diasumsikan in-range.
  Revisit: saat reconciliation/management logic mulai memakai `outOfRangeSince` secara aktif.

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

## Closed
- `F1` transition ke `OPEN` tidak lagi hardcoded dari literal `DEPLOYING`; sekarang memakai `pendingPosition.status`.
- `F2` gateway position hanya dianggap confirmed jika status benar-benar `OPEN`.
- `F3` submit on-chain sukses + persist lokal gagal tidak lagi orphan silent; flow dinaikkan ke reconcile-safe path.
- `F4` regression test untuk gateway non-`OPEN` sudah ada.
- `F7` regression test re-confirmation idempotent sudah ada.
- `N8` partial-commit risk di confirm deploy happy path sudah ditutup dengan ordering commit yang lebih aman.
- `N9` partial-commit risk di confirm deploy timeout path sudah ditutup dengan ordering commit yang lebih aman.
- `N12` empty error message sekarang dinormalisasi jadi safe fallback.

## Next Review Gate
- Review file ini sebelum mulai Batch 7.
- Review lagi sebelum Batch 16 untuk semua item yang menyentuh real adapter boundary.
- Review terakhir sebelum Batch 18/live-readiness untuk memastikan tidak ada deferred item yang ternyata masih high-impact.
