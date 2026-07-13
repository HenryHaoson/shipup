import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  b64url,
  loadPlatformCreds,
  readZipEntry,
  redactText,
  redactUrl,
  resolveValue,
} from "../lib/common.mjs";
import { storedZip } from "./helpers.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "shipup-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("b64url emits URL-safe text without padding", () => {
  assert.equal(b64url(Buffer.from([0xfb, 0xff, 0xef])), "-__v");
});

test("resolveValue supports literals, environment variables, and files", () => withTempDir((dir) => {
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, "secret-from-file\n", { mode: 0o600 });
  process.env.SHIPUP_TEST_VALUE = "secret-from-env";
  try {
    assert.equal(resolveValue("literal", dir), "literal");
    assert.equal(resolveValue("${SHIPUP_TEST_VALUE}", dir), "secret-from-env");
    assert.equal(resolveValue("@key.txt", dir), "secret-from-file");
  } finally {
    delete process.env.SHIPUP_TEST_VALUE;
  }
}));

test("loadPlatformCreds selects a platform section and resolves indirection", () => withTempDir((dir) => {
  const creds = join(dir, "credentials.yaml");
  const key = join(dir, "private.p8");
  writeFileSync(key, "private-key-material", { mode: 0o600 });
  writeFileSync(creds, [
    "ios:",
    "  app_id: '123'",
    "  bundle_id: com.example.app",
    "  private_key: @private.p8",
    "harmony:",
    "  app_id: '456'",
  ].join("\n"), { mode: 0o600 });
  chmodSync(creds, 0o600);

  const ios = loadPlatformCreds(creds, "ios");
  assert.equal(ios.app_id, "123");
  assert.equal(ios.bundle_id, "com.example.app");
  assert.equal(ios.private_key, "private-key-material");
  assert.equal(ios._baseDir, dir);
}));

test("readZipEntry reads a stored entry and fails soft for missing data", () => {
  const zip = storedZip("pack.info", '{"ok":true}');
  assert.equal(readZipEntry(zip, "pack.info")?.toString("utf8"), '{"ok":true}');
  assert.equal(readZipEntry(zip, "missing"), null);
  assert.equal(readZipEntry(Buffer.from("not a zip"), "pack.info"), null);
});

test("redaction removes secrets and URL query parameters", () => {
  const raw = [
    "Authorization: Bearer header.payload.signature",
    '"access_token":"token-value"',
    "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactText(raw);
  assert.doesNotMatch(redacted, /header\.payload|token-value|private-material/);
  assert.match(redacted, /redacted/);
  assert.equal(
    redactUrl("https://example.com/upload?signature=secret&appId=123"),
    "https://example.com/upload",
  );
});

test("credential fixtures contain no unexpected data", () => {
  const example = readFileSync(new URL("../creds.example.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(example, /BEGIN (?:RSA |EC )?PRIVATE KEY/);
  assert.match(example, /com\.example\.app/);
});
