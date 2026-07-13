# shipup

[![CI](https://github.com/HenryHaoson/shipup/actions/workflows/ci.yml/badge.svg)](https://github.com/HenryHaoson/shipup/actions/workflows/ci.yml)

`shipup` is a Node.js CLI for uploading, submitting, inspecting, and releasing
mobile applications across major app stores:

- HarmonyOS AppGallery Connect (`.app`);
- Android: Huawei, Honor, OPPO, vivo, Xiaomi, Samsung, Tencent MyApp, and Meizu (`.apk`);
- Apple App Store Connect (`.ipa`).

It is designed for local automation and CI: JSON goes to stdout, diagnostics go
to stderr, provider states and exit codes are normalized, and `--dry-run`
performs local validation without network requests.

> `shipup` is an independent community project and is not affiliated with or
> endorsed by any supported store operator.

## Requirements

- Node.js 18.17 or newer.
- iOS upload requires macOS, Xcode, and `xcrun altool`.
- Android icon extraction requires Android SDK `aapt`/`aapt2`; alternatively pass `--icon`.
- Provider credentials authorized for the target application.

## Install

```bash
npm install --global shipup
shipup --help
```

Published releases are delivered from GitHub Actions to npm through OIDC trusted
publishing; the workflow does not store a long-lived npm token.

## Quick start

```bash
mkdir -p ~/.config/shipup
cp creds.example.yaml ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/credentials.yaml
```

Credentials are resolved from `--creds`, then `SHIPUP_CREDS`, then
`~/.config/shipup/credentials.yaml`.

```bash
# HarmonyOS
shipup harmony status
shipup harmony upload --package ./application.app --dry-run

# Android multi-market upload
shipup android upload \
  --upload huawei=./app-huawei.apk honor=./app-honor.apk \
  --release-note @./release-note.txt \
  --submit-review --output json
shipup android status --channel huawei

# App Store Connect
shipup ios upload --package ./application.ipa --dry-run
shipup ios submit --app-version 2.0.0 --build-version 200 --bundle-id com.example.app
shipup ios status --app-version 2.0.0 --bundle-id com.example.app
shipup ios release --app-version 2.0.0 --bundle-id com.example.app --phased
```

## Commands

```text
shipup harmony upload|submit|status
shipup huawei  upload|status                    # compatibility command
shipup android upload|status                    # eight Android markets
shipup ios     upload|submit|status|release
```

Android upload supports release notes, icons, screenshots, application names,
summaries, and descriptions where the selected market API supports them. See
[Provider behavior](docs/providers.md) and [Android market capabilities](docs/android-markets.md).

## Output and exit codes

`--output json` returns a stable object with `tool`, `platform`, `command`,
`ok`, `summary`, and per-channel `results`. Normalized states include
`uploaded`, `submitted`, `pending_review`, `approved`, `published`, `rejected`,
`offline`, `skipped`, and `failed`.

| Code | Meaning |
|---:|---|
| `0` | success |
| `1` | partial multi-channel failure |
| `2` | provider or processing failure |
| `3` | invalid CLI usage |
| `4` | missing or invalid credentials |
| `5` | missing or invalid package input |
| `124` | timeout |

Read [Credentials](docs/credentials.md) and [Security](SECURITY.md) before using
production accounts.

## Development

```bash
npm run check
npm run security
npm test
npm run test:coverage
npm run pack:check
npm audit
```

## License

[Zero-Clause BSD](LICENSE).
