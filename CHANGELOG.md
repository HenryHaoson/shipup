# Changelog

All notable changes to this project will be documented in this file.

## 0.2.2 - 2026-07-13

- Fix vivo signature verification for multiline release notes and descriptions by
  matching the CRLF normalization performed during multipart serialization.

## 0.2.1 - 2026-07-13

- Publish `shipup` to npm and document global installation.
- Publish future GitHub Releases through OIDC trusted publishing with automatic
  provenance and strict release-tag validation.

## 0.2.0 - 2026-07-13

- Add Android multi-market upload and status commands for Huawei, Honor, OPPO,
  vivo, Xiaomi, Samsung, Tencent MyApp, and Meizu.
- Add APK metadata and ABI inspection, launcher-icon extraction, image resizing,
  screenshot processing, and optional store-listing metadata updates.
- Expand App Store Connect commands with bundle-ID lookup, standalone build
  submission, localization metadata, and idempotent phased release.
- Support combined `android`, `harmony`, `huawei`, and `ios` credential sections
  in the default credentials file.
- Add credential permission warnings and redaction for multi-market provider
  errors and signed responses.
- Preserve the original HarmonyOS and Huawei compatibility commands.

## 0.1.0 - 2026-07-13

- Add HarmonyOS AppGallery upload, submit, and status commands.
- Add Huawei Android APK upload and status commands.
- Add iOS upload, submit, status, and phased-release commands.
- Add normalized JSON output, stable exit codes, credential indirection, global
  timeout handling, and dry-run validation.
