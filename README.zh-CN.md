# shipup

`shipup` 是一个跨平台应用商店发布 CLI，支持：

- HarmonyOS `.app`：AppGallery Connect；
- Android APK：华为、荣耀、OPPO、vivo、小米、三星、应用宝、魅族；
- iOS `.ipa`：App Store Connect 上传、提审、状态查询和灰度发布。

它适合本地自动化和 CI：JSON 只写 stdout，过程信息写 stderr，状态和退出码统一，
`--dry-run` 只做本地校验，不发网络请求。

> `shipup` 是独立社区项目，与各应用市场运营方不存在隶属或官方背书关系。

## 环境

- Node.js 18.17 或更新版本；
- iOS 上传需要 macOS、Xcode 和 `xcrun altool`；
- Android 自动提取图标需要 Android SDK 的 `aapt`/`aapt2`，也可显式传 `--icon`；
- 对目标应用具备相应权限的平台凭证。

## 安装

首次 npm registry 发布前，可从仓库或固定 Git tag 安装：

```bash
npm install
npm link
shipup --help
```

## 凭证

```bash
mkdir -p ~/.config/shipup
cp creds.example.yaml ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/credentials.yaml
```

查找顺序为 `--creds`、`SHIPUP_CREDS`、`~/.config/shipup/credentials.yaml`。
值支持字面量、`${ENVIRONMENT_VARIABLE}` 和 `@相对文件`。完整结构见
[凭证说明](docs/credentials.md)。

## 使用

```bash
# HarmonyOS
shipup harmony status
shipup harmony upload --package ./application.app --dry-run

# Android 多渠道
shipup android upload \
  --upload huawei=./app-huawei.apk honor=./app-honor.apk \
  --release-note @./release-note.txt \
  --submit-review --output json
shipup android status --channel huawei

# iOS
shipup ios upload --package ./application.ipa --dry-run
shipup ios submit --app-version 2.0.0 --build-version 200 --bundle-id com.example.app
shipup ios status --app-version 2.0.0 --bundle-id com.example.app
shipup ios release --app-version 2.0.0 --bundle-id com.example.app --phased
```

命令总览：

```text
shipup harmony upload|submit|status
shipup huawei  upload|status                    # 原华为兼容命令
shipup android upload|status                    # Android 八渠道
shipup ios     upload|submit|status|release
```

Android 上传支持按渠道更新发布说明、图标、截图、应用名、一句话简介和长描述。
各市场具体支持情况见 [平台行为](docs/providers.md) 和
[Android 市场能力表](docs/android-markets.md)。

iOS 新参数统一为 `--app-version` 和 `--build-version`；旧的 `--version`、`--build`
仍可使用。`--bundle-id` 可以自动反查 App Store Connect 数字 App ID。

## 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | 成功 |
| `1` | 多渠道部分失败 |
| `2` | 全部失败或平台处理失败 |
| `3` | 参数错误 |
| `4` | 凭证缺失或无效 |
| `5` | 软件包缺失或无效 |
| `124` | 超时 |

生产使用前请阅读 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm run check
npm run security
npm test
npm run test:coverage
npm run pack:check
npm audit
```

许可证：[Zero-Clause BSD](LICENSE)。
