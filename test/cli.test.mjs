import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { storedZip } from "./helpers.mjs";

const cli = resolve(new URL("../shipup.mjs", import.meta.url).pathname);
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "shipup-cli-"));
  const creds = join(dir, "credentials.yaml");
  writeFileSync(creds, [
    "android:",
    "  package_name: com.example.app",
    "  channels:",
    "    huawei:",
    "      app_id: '400'",
    "      client_id: client",
    "      client_secret: secret",
    "harmony:",
    "  app_id: '100'",
    "  package_name: com.example.app",
    "huawei:",
    "  app_id: '200'",
    "  package_name: com.example.app",
    "ios:",
    "  app_id: '300'",
    "  bundle_id: com.example.app",
    "  issuer_id: issuer",
    "  key_id: key",
    "  private_key: fake-private-key",
  ].join("\n"), { mode: 0o600 });
  chmodSync(creds, 0o600);
  return { dir, creds };
}

test("help and version are available without credentials", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /shipup harmony upload/);
  assert.match(help.stdout, /shipup harmony submit/);
  assert.match(help.stdout, /shipup harmony status/);

  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), packageVersion);

  const androidHelp = run(["android", "upload", "--help"]);
  assert.equal(androidHelp.status, 0);
  assert.match(androidHelp.stdout, /--huawei-release-mode/);
  assert.match(androidHelp.stdout, /--huawei-phased-percent/);
});

test("invalid usage and missing credentials use stable exit codes", () => {
  assert.equal(run(["unknown", "status"]).status, 3);
  const missingHome = mkdtempSync(join(tmpdir(), "shipup-home-"));
  try {
    const result = run(["harmony", "status", "--dry-run"], {
      HOME: missingHome,
      SHIPUP_CREDS: "",
    });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /未找到凭证/);
  } finally {
    rmSync(missingHome, { recursive: true, force: true });
  }
});

test("SHIPUP_CREDS supplies the default credential file", () => {
  const { dir, creds } = tempProject();
  try {
    const result = run(["harmony", "status", "--dry-run", "--output", "json"], {
      SHIPUP_CREDS: creds,
    });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.results[0].status, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Huawei dry-run validates package shape without network access", () => {
  const { dir, creds } = tempProject();
  try {
    const apk = join(dir, "sample.apk");
    writeFileSync(apk, "not-a-real-apk");
    const result = run([
      "huawei", "upload", "--creds", creds, "--package", apk,
      "--dry-run", "--output", "json",
    ]);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).results[0].status, "skipped");

    const wrong = join(dir, "sample.zip");
    writeFileSync(wrong, "wrong-extension");
    assert.equal(run(["huawei", "upload", "--creds", creds, "--package", wrong, "--dry-run"]).status, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Harmony dry-run rejects a package for another application", () => {
  const { dir, creds } = tempProject();
  try {
    const app = join(dir, "sample.app");
    writeFileSync(app, storedZip("pack.info", JSON.stringify({
      summary: { app: { bundleName: "com.other.app", version: { name: "1.0.0", code: 1 } } },
    })));
    const result = run(["harmony", "upload", "--creds", creds, "--package", app, "--dry-run"]);
    assert.equal(result.status, 5);
    assert.match(result.stderr, /包名不匹配/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iOS dry-run does not invoke Xcode upload tools", () => {
  const { dir, creds } = tempProject();
  try {
    const ipa = join(dir, "sample.ipa");
    writeFileSync(ipa, "not-a-real-ipa");
    const result = run([
      "ios", "upload", "--creds", creds, "--package", ipa,
      "--dry-run", "--output", "json",
    ], { PATH: "" });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).results[0].status, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android multi-market dry-run uses default credentials and standard JSON", () => {
  const { dir, creds } = tempProject();
  try {
    const apk = join(dir, "sample.apk");
    writeFileSync(apk, storedZip("AndroidManifest.xml", "fixture"));
    const result = run([
      "android", "upload", "--upload", `huawei=${apk}`,
      "--version-name", "1.2.3", "--version-code", "123",
      "--dry-run", "--output", "json",
    ], { SHIPUP_CREDS: creds });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.tool, "shipup");
    assert.equal(json.platform, "android");
    assert.equal(json.results[0].channel, "huawei");
    assert.equal(json.results[0].status, "skipped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("iOS legacy --version and --build aliases remain compatible", () => {
  const { dir, creds } = tempProject();
  try {
    const result = run([
      "ios", "submit", "--creds", creds,
      "--version", "1.2.3", "--build", "123",
      "--dry-run", "--output", "json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.results[0].versionName, "1.2.3");
    assert.equal(json.results[0].versionCode, "123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multi-market CLI rejects invalid timeout, output, and concurrency values", () => {
  const { dir, creds } = tempProject();
  try {
    assert.equal(run([
      "android", "status", "--channel", "huawei", "--creds", creds,
      "--timeout", "0", "--dry-run",
    ]).status, 3);
    assert.equal(run([
      "android", "status", "--channel", "huawei", "--creds", creds,
      "--output", "xml", "--dry-run",
    ]).status, 3);
    assert.equal(run([
      "android", "upload", "--upload", "huawei=missing.apk", "--creds", creds,
      "--concurrency", "0", "--dry-run",
    ]).status, 3);
    assert.equal(run([
      "android", "upload", "--upload", "huawei=missing.apk", "--creds", creds,
      "--huawei-release-mode", "rolling", "--dry-run",
    ]).status, 3);
    assert.equal(run([
      "android", "upload", "--upload", "huawei=missing.apk", "--creds", creds,
      "--huawei-phased-percent", "101", "--dry-run",
    ]).status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
