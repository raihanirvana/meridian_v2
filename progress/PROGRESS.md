# Meridian V2 Progress

Last updated: 2026-04-21
Current batch: Batch 7 - Use case close + finalizer accounting
Status: Complete

## Scope Batch 7
- Implement request close lewat queue
- Implement queue-side close submission handler
- Implement finalizer close sampai posisi `CLOSED` atau jalur reconcile-safe
- Tambahkan tests untuk close success, timeout, dan accounting failure

## Completed
- PRD V2 sudah dibaca dan dijadikan source of truth
- Repo lama `Desktop/meridian` sudah diaudit sebagai referensi perilaku dan anti-pattern
- Batch 0 selesai:
  - bootstrap TypeScript greenfield
  - setup `vitest`, `eslint`, `prettier`, `zod`, dan `pino`
  - contoh schema dan dummy test
  - verifikasi `lint`, `build`, dan `test`
- Batch 1 selesai:
  - strict config schema
  - config loader dengan boundary `.env` vs `user-config.json`
  - `.env.example` dan `user-config.example.json`
  - `ConfigValidationError` + secret redaction
  - verifikasi `lint`, `build`, dan `test`
- Batch 2 selesai:
  - enums lifecycle resmi
  - entity schema `Position`, `Action`, `Candidate`, `PortfolioState`
  - state machine pure untuk `Position` dan `Action`
  - lifecycle review fixes sudah masuk
  - verifikasi `lint`, `build`, dan `test`
- Batch 3 selesai:
  - file-based persistence untuk positions/actions
  - append-only journal
  - atomic replace dengan backup-restore
  - verifikasi persist/reload dan failure recovery
  - verifikasi `lint`, `build`, dan `test`
- Batch 4 selesai:
  - wallet/position locks
  - queue skeleton
  - idempotency key generator
  - sequential write guarantee test
  - verifikasi `lint`, `build`, dan `test`
- File Batch 5 sudah ditambahkan:
  - `src/adapters/mockBehavior.ts`
  - `src/adapters/dlmm/DlmmGateway.ts`
  - `src/adapters/jupiter/SwapGateway.ts`
  - `src/adapters/screening/ScreeningGateway.ts`
  - `src/adapters/analytics/TokenIntelGateway.ts`
  - `src/adapters/llm/LlmGateway.ts`
  - `src/adapters/telegram/NotifierGateway.ts`
  - `tests/unit/mockGateways.test.ts`
- Adapter contracts yang sekarang tersedia:
  - `DlmmGateway`
  - `SwapGateway`
  - `ScreeningGateway`
  - `TokenIntelGateway`
  - `LlmGateway`
  - `NotifierGateway`
- Mock behavior yang sekarang tersedia:
  - `success`
  - `fail`
  - `timeout`
- Export surface di `src/index.ts` sudah diperbarui untuk semua gateway contract dan mock
- Verifikasi Batch 5 selesai:
  - `npm run lint` ✅
  - `npm run build` ✅
  - `npm test` ✅
- Hardening after audit sudah masuk:
  - `KeyedLock` cleanup fixed, `isLocked()` tidak stuck true
  - `ActionQueue` sekarang mengubah handler throw menjadi `FAILED`
  - repository upsert sekarang tidak lost-update saat write paralel
  - `FileStore` sekarang punya recovery untuk orphan `.tmp` / `.bak`
  - `ActionQueue` sekarang bisa menulis journal event untuk enqueue/running/finalize/fail
  - `JournalRepository` sekarang tolerate malformed trailing line
  - regression tests untuk semua bug audit kritis sudah ditambahkan
  - regression untuk H1 ditambahkan: claimed action tidak leak saat processing gagal sebelum handler jalan
  - `ActionQueue` sekarang reset `startedAt` saat retry masuk `RUNNING` lagi
  - `DlmmGateway` contract sekarang lebih lengkap: partial close, wallet position listing, pool info
  - `LlmGateway` management explanation sekarang menerima `positionSnapshot` dan `triggerReasons`
  - residue `ExampleActionEnvelopeSchema` dari Batch 0 sudah dibersihkan
  - boundary IO schemas sekarang mulai diexport untuk adapter contracts penting
  - selective hardening N1/N2/N3 sudah masuk:
    - `ActionQueue.QueueExecutionResult.nextStatus` dipersempit ke transisi yang benar-benar legal dari `RUNNING`
    - `TokenIntelGateway`, `SwapGateway`, dan `NotifierGateway` sekarang punya Zod schemas untuk boundary IO
    - `DlmmGateway` dan `LlmGateway` sekarang memakai `PositionSchema` aktual, bukan `z.custom<Position>()`
    - regression tests ditambahkan untuk boundary validation yang sebelumnya lolos tanpa parse runtime
- Batch 6 selesai:
  - `requestDeploy.ts` sudah membuat deploy request via `ActionQueue`, bukan direct write
  - `processDeployAction.ts` sudah submit deploy ke gateway dan membuat posisi `DEPLOYING`
  - confirmation handler sekarang mengubah action `WAITING_CONFIRMATION -> RECONCILING -> DONE`
  - posisi hanya menjadi `OPEN` setelah confirmation sukses
  - jika confirmation tidak muncul, action menjadi `TIMED_OUT` dan posisi masuk `RECONCILIATION_REQUIRED`
  - journal deploy-specific sekarang ditulis untuk accepted, submitted, confirmed, dan timeout/failure
  - integration test deploy flow end-to-end sudah ditambahkan
  - hardening deploy audit fixes sudah masuk:
    - transisi `OPEN` sekarang memakai `pendingPosition.status`, bukan hardcoded `DEPLOYING`
    - gateway `getPosition()` hanya dianggap confirmed jika status benar-benar `OPEN`
    - jika submit on-chain sukses tetapi persist lokal gagal, action tidak jatuh ke `FAILED`; flow dinaikkan ke jalur reconcile-safe
    - regression test ditambahkan untuk non-OPEN confirmation, repeat confirmation idempotent, dan post-submit local write failure
    - confirmation commit ordering sekarang lebih aman:
      - happy path membangun dan menyimpan `OPEN` position dulu sebelum action dipindah ke `RECONCILING`
      - timeout path membangun dan menyimpan `RECONCILIATION_REQUIRED` position dulu sebelum action ditutup ke `TIMED_OUT`
      - regression test ditambahkan untuk malformed confirmed payload dan failure saat timeout reconciliation write
- Batch 7 selesai:
  - `requestClose.ts` sudah membuat close request via `ActionQueue`, bukan direct write
  - `processCloseAction.ts` sudah submit close ke gateway dan memindahkan posisi ke `CLOSING`
  - `finalizeClose.ts` sekarang menangani confirmation + accounting finalization sampai `CLOSED`
  - posisi tidak pernah menjadi `CLOSED` sebelum finalizer accounting sukses
  - jika close confirmation tidak muncul, action menjadi `TIMED_OUT` dan posisi masuk `RECONCILIATION_REQUIRED`
  - jika close confirmed tetapi accounting/post-close finalization gagal, action menjadi `FAILED` dan posisi masuk `RECONCILIATION_REQUIRED`
  - optional post-close swap hook interface sudah ditambahkan sebagai extension point finalizer
  - integration test close flow end-to-end sudah ditambahkan untuk success, timeout, dan accounting failure
  - hardening Batch 7 yang ikut masuk:
    - `Action.positionId` sekarang cross-validated terhadap `Action.type`, jadi `CLOSE`/`CLAIM_FEES`/`PARTIAL_CLOSE`/`REBALANCE` scoped action tidak bisa kehilangan `positionId`
    - enqueue idempotency sekarang atomic, jadi request paralel dengan idempotency key yang sama tidak membuat duplicate action
    - deploy confirmation sekarang mengisi `outOfRangeSince` saat posisi confirmed langsung berada di luar range
    - close finalizer menjaga semantik `outOfRangeSince` tetap konsisten saat posisi masuk jalur `CLOSE_CONFIRMED -> RECONCILING -> CLOSED`

## Pending
- Tidak ada blocker fungsional untuk Batch 7
- Lihat debt register terpisah di [DEBT_AND_DECISIONS.md](<c:/Users/PC/Desktop/meridian_v2/progress/DEBT_AND_DECISIONS.md:1>) untuk deferred fixes dan keputusan desain
- Temuan low-priority sengaja ditunda dulu agar scope tetap ketat:
  - N4 orphan temp artifact cleanup
  - N6 optimasi syscall recovery check
  - N7 shared schema cleanup kecil
  - N10 gateway field pollution lewat spread
- Debt yang tadinya dibawa ke Batch 7 sudah ditutup:
  - N5 cross-validation `Action.positionId` vs `Action.type`
  - N11 semantik `outOfRangeSince`

## Decisions
- V2 mengikuti PRD greenfield, bukan struktur repo lama
- Progress note ini harus terus diupdate tiap batch untuk memudahkan handoff ke AI lain
- Vitest perlu dijalankan di luar sandbox pada environment ini karena `esbuild` kena `spawn EPERM` di sandbox
- Semua batch berikutnya harus bergantung pada interface gateway, bukan SDK/vendor langsung
- Mock gateway memakai `MockBehavior` yang seragam supaya integration tests batch selanjutnya tetap simpel
- File persistence sekarang memakai keyed lock per file path di level `FileStore`, bukan hanya mengandalkan lock di service layer
- Prinsip eksekusi saat ini: prioritaskan fix yang berpotensi mengganggu production atau batch berikutnya, dan tunda cleanup yang belum memberi leverage nyata
- Di Batch 6, posisi pending deploy baru dimaterialisasi saat submit gateway sukses dan `positionId` canonical sudah diketahui; tidak ada posisi `OPEN` sebelum confirmation
- Di Batch 7, close finalization memisahkan submit close dari accounting finalizer; posisi baru menjadi `CLOSED` setelah confirmation dan finalizer sama-sama sukses
- Idempotency enqueue sekarang harus atomic di repository layer, bukan check-then-insert di `ActionQueue`

## Next Recommended Step
- Batch 8: reconciliation worker

## Handoff Notes
- Repo ini awalnya kosong kecuali PRD
- Jika test dijalankan di sandbox dan gagal `spawn EPERM`, rerun `npm test` dengan escalation
- Jangan pakai repo lama sebagai source implementasi; pakai hanya untuk parity/spec bila diperlukan
- Deploy/close use case di batch berikutnya sebaiknya langsung bergantung pada `ActionQueue` + `ActionRepository` + gateway interfaces yang sudah ada
- Deploy flow saat ini mengandalkan `DlmmGateway.getPosition(positionId)` sebagai confirmation check pada mock/integration layer
- Close flow saat ini mengandalkan `DlmmGateway.getPosition(positionId)` mengembalikan status `CLOSE_CONFIRMED` sebelum finalizer menutup posisi lokal
- `npm test` terakhir hijau dengan total `55` tests passed
