# Provider behavior

## HarmonyOS AppGallery

`harmony upload` validates `pack.info` when available, obtains an OBS upload URL,
streams the `.app` package, registers it, and optionally waits for compilation
analysis. `harmony submit` supports immediate, scheduled, and phased submission.

## Huawei Android

`huawei upload` accepts an APK, uploads it through the AppGallery Connect file
endpoint, binds the package, updates release notes, and optionally submits it for
review. Store artwork and screenshots are intentionally outside the CLI scope.

## App Store Connect

`ios upload` validates the IPA bundle identifier when macOS package tools are
available and uploads through Xcode command-line tools. `ios submit` waits for a
valid build, creates or reuses the App Store version, writes localizations,
attaches the build, and submits it. `ios release` controls manual or phased
release state.

The iOS upload command requires macOS and Xcode. Status, submission, and release
commands use the App Store Connect HTTP API but are currently supported only on
the platforms covered by the project's CI matrix.
