# Provider behavior

## HarmonyOS AppGallery

`harmony upload` validates `pack.info` when present, obtains an OBS upload URL,
streams the `.app`, registers it, and normally waits for compilation analysis.
`harmony submit` supports immediate, scheduled, and phased submission.
`harmony status` normalizes AppGallery release states.

## Android multi-market

`android upload` accepts one or more `--upload channel=apk` values and isolates
failures per channel. The supported channel names are:

| Channel | Store | Upload | Status | Optional metadata |
|---|---|---:|---:|---|
| `huawei` | Huawei AppGallery | yes | yes | icon, screenshots, name, summary, description, release notes |
| `honor` | Honor App Market | yes | yes | icon, screenshots, name, summary, description, release notes |
| `oppo` | OPPO App Market | yes | yes | icon, screenshots, name, summary, description, release notes |
| `vivo` | vivo App Store | yes | yes | icon, screenshots, name, summary, description, release notes |
| `xiaomi` | Xiaomi App Store | yes | yes | icon, screenshots, name, summary, description, release notes |
| `samsung` | Samsung Galaxy Store | yes | yes | icon, screenshots, name, summary, description, release notes |
| `qq` | Tencent MyApp | yes | yes | icon, screenshots, name, summary, description, release notes |
| `meizu` | Meizu App Store | yes | yes | icon, screenshots, name, summary, description, release notes |

Most Android market upload APIs submit or publish as part of upload; they do
not provide a universal upload-only draft operation. `--submit-review` is an
explicit intent marker, and the CLI prints a warning when it is omitted.

Package name and version metadata are read from the APK unless supplied with
`--version-name`, `--version-code`, and credentials. Native ABI contents are
inspected for channels that distinguish 32-bit and 64-bit packages.

Icons use `--icon` when supplied. Otherwise, channels that require a new icon
use `aapt`/`aapt2` to select the highest-density raster launcher icon from the
APK. Images are resized and compressed to provider limits. Screenshots and text
metadata are updated only when their corresponding options are present.
Detailed constraints are listed in [Android market capabilities](android-markets.md).

## Huawei compatibility command

`huawei upload|status` preserves the original service-account-oriented Huawei
workflow. New multi-market automation should normally use
`shipup android ... --upload huawei=...` so it can share orchestration and
metadata options with other Android markets.

## App Store Connect

`ios upload` uploads through `xcrun altool` and can continue into submission.
`ios submit` waits for a valid existing build, creates or reuses the App Store
version, writes localizations, attaches the build, and submits the review.
`--bundle-id` can resolve the numeric App ID automatically.

`ios status` normalizes App Store state and includes phased-release state when
available. `ios release` supports manual release, starting phased release,
completing it immediately, pausing, and resuming. Repeated phased-release
commands are guarded for idempotency.

iOS upload requires macOS and Xcode. HTTP-only status, submission, and release
commands run wherever the supported Node.js runtime is available.
