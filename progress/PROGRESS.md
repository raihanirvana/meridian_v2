# Meridian V2 Progress

Last updated: 2026-04-18
Current batch: Batch 1 - Config schema dan environment boundary
Status: Complete

## Scope Batch 1
- Implement strict config schema
- Pisahkan secrets `.env` dari non-secret `user-config.json`
- Tambahkan `.env.example` dan `user-config.example.json`
- Tambahkan redacted logging helper untuk config
- Tambahkan tests untuk valid config, secret boundary, invalid config, dan unknown keys

## Completed
- PRD V2 sudah dibaca dan dijadikan source of truth
- Repo lama `Desktop/meridian` sudah diaudit sebagai referensi perilaku dan anti-pattern
- Struktur folder awal V2 sudah dibuat
- Batch 0 selesai:
  - bootstrap TypeScript greenfield
  - setup `vitest`, `eslint`, `prettier`, `zod`, dan `pino`
  - contoh schema dan dummy test
  - verifikasi `lint`, `build`, dan `test`
- File Batch 1 sudah ditambahkan:
  - `src/infra/config/configSchema.ts`
  - `src/infra/config/loadConfig.ts`
  - `.env.example`
  - `user-config.example.json`
  - `tests/unit/loadConfig.test.ts`
- Boundary config sudah aktif:
  - secrets dibaca dari `.env`
  - non-secret dibaca dari `user-config.json`
  - unknown keys ditolak secara strict
  - secret-like keys di `user-config.json` gagal dengan pesan eksplisit
  - helper `redactSecretsForLogging()` tersedia
- Verifikasi Batch 1 selesai:
  - `npm run lint` ✅
  - `npm run build` ✅
  - `npm test` ✅

## Pending
- Tidak ada blocker fungsional untuk Batch 1
- Opsional: inisialisasi git repo jika memang mau mulai commit dari folder ini

## Decisions
- V2 mengikuti PRD greenfield, bukan struktur repo lama
- Progress note ini harus terus diupdate tiap batch untuk memudahkan handoff ke AI lain
- Vitest perlu dijalankan di luar sandbox pada environment ini karena `esbuild` kena `spawn EPERM` di sandbox
- `loadConfig()` melempar `ConfigValidationError` dengan `details` yang cocok untuk troubleshooting atau surface ke operator

## Next Recommended Step
- Batch 2: domain enums, entities, dan explicit state machine untuk Position dan Action

## Handoff Notes
- Repo ini awalnya kosong kecuali PRD
- Belum ada `.git` di `meridian_v2`
- Jika test dijalankan di sandbox dan gagal `spawn EPERM`, rerun `npm test` dengan escalation
- Jangan pakai repo lama sebagai source implementasi; pakai hanya untuk parity/spec bila diperlukan
