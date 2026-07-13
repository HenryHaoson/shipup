# shipup

[![CI](https://github.com/HenryHaoson/shipup/actions/workflows/ci.yml/badge.svg)](https://github.com/HenryHaoson/shipup/actions/workflows/ci.yml)

`shipup` is a zero-dependency Node.js CLI for uploading, submitting, inspecting,
and releasing mobile applications through:

- AppGallery Connect Publishing API v3 for HarmonyOS `.app` packages;
- AppGallery Connect Publish API v2 for Android APKs;
- App Store Connect API for iOS submissions and phased releases.

It is designed for CI pipelines: JSON results go to stdout, progress goes to
stderr, state names and exit codes are consistent across providers, and
`--dry-run` validates local inputs without making network requests.

> `shipup` is an independent community project and is not affiliated with,
> endorsed by, or supported by Apple or Huawei.

## Requirements

- Node.js 18.17 or newer.
- The iOS upload command requires macOS, Xcode, and `xcrun altool`.
- Provider credentials with permission to upload or submit the target app.

## Install

Until the first registry release, install from a checked-out repository:

```bash
npm install
npm link
shipup --help
```

For release automation, pin an exact package version in the consuming project.
Do not run an unpinned latest version during a production release.

## Quick start

Create a credentials file outside the source tree:

```bash
mkdir -p ~/.config/shipup
cp creds.example.yaml ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/credentials.yaml
```

Then use `--creds`, `SHIPUP_CREDS`, or the default credentials path:

```bash
shipup harmony status --creds ~/.config/shipup/credentials.yaml
shipup huawei upload --package ./app-release.apk --submit-review
shipup ios status --version 1.0.0
```

See [Credentials](docs/credentials.md) and [Providers](docs/providers.md) for
configuration and platform-specific behavior.

## Commands

```text
shipup harmony upload|submit|status
shipup huawei  upload|status
shipup ios     upload|submit|status|release
```

All commands support:

- `--creds <path>` to select a credential file;
- `--output json|text`;
- `--timeout <seconds>`;
- `--dry-run`.

## Output and exit codes

JSON output follows this shape:

```json
{
  "tool": "shipup",
  "platform": "harmony",
  "command": "status",
  "ok": true,
  "summary": { "total": 1, "succeeded": 1, "failed": 0, "skipped": 0 },
  "results": [{ "channel": "appgallery", "status": "published" }]
}
```

Exit codes:

| Code | Meaning |
|---:|---|
| `0` | success |
| `2` | provider or processing failure |
| `3` | invalid CLI usage |
| `4` | missing or invalid credentials |
| `5` | missing or mismatched package input |
| `124` | overall timeout |

Normalized states are `uploaded`, `submitted`, `pending_review`, `approved`,
`published`, `rejected`, `offline`, `draft`, `skipped`, and `failed`.

## Safety boundary

The CLI intentionally does not create apps, alter compliance questionnaires,
replace store artwork, withdraw submissions, or remove published apps. Those
low-frequency or destructive actions remain in the provider console.

Read [SECURITY.md](SECURITY.md) before using production credentials.

## Development

```bash
npm run check
npm test
npm run test:coverage
npm run pack:check
```

## License

[Zero-Clause BSD](LICENSE).
