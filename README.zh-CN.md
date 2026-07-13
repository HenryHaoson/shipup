# shipup

`shipup` 是一个零 npm 依赖的移动应用发布 CLI，面向：

- HarmonyOS `.app`：AppGallery Connect Publishing API v3；
- Android APK：AppGallery Connect Publish API v2；
- iOS：App Store Connect 上传、提审、状态与灰度发布。

它适合 CI：JSON 只写 stdout，过程信息写 stderr，三渠道使用统一状态和退出码，
并提供不会发起网络请求的 `--dry-run`。

> `shipup` 是独立社区项目，与 Apple、Huawei 无隶属、背书或官方支持关系。

## 环境

- Node.js 18.17 或更新版本；
- iOS 上传仅支持已安装 Xcode 的 macOS；
- 对目标应用具备上传或提审权限的平台凭证。

## 本地使用

```bash
npm install
npm link
shipup --help
```

凭证必须放在源码目录之外：

```bash
mkdir -p ~/.config/shipup
cp creds.example.yaml ~/.config/shipup/credentials.yaml
chmod 600 ~/.config/shipup/credentials.yaml
```

命令可以显式传 `--creds`，也可以使用 `SHIPUP_CREDS` 或默认路径：

```bash
shipup harmony status
shipup huawei upload --package ./app-release.apk --submit-review
shipup ios status --version 1.0.0
```

完整凭证说明见 [docs/credentials.md](docs/credentials.md)，平台行为见
[docs/providers.md](docs/providers.md)。

## 安全边界

工具有意不处理应用创建、内容分级、合规问卷、商店素材、撤审和下架。这些低频或
危险操作继续留在平台控制台完成。生产使用前请阅读 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm run check
npm test
npm run test:coverage
npm run pack:check
```

许可证：[Zero-Clause BSD](LICENSE)。
