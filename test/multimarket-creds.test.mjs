import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCreds } from "../dist/creds/load.js";

test("multi-market credentials accept legacy unquoted @file values", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipup-multimarket-creds-"));
  try {
    const key = join(dir, "private.pem");
    const credentials = join(dir, "credentials.yaml");
    writeFileSync(key, "fixture-key", { mode: 0o600 });
    writeFileSync(credentials, [
      "ios:",
      "  app_id: '123'",
      "  private_key: @./private.pem",
    ].join("\n"), { mode: 0o600 });
    chmodSync(credentials, 0o600);
    const ios = loadCreds(credentials, "ios");
    assert.equal(ios.app_id, "123");
    assert.equal(ios.private_key, "fixture-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential loading resolves only the selected platform section", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipup-selected-creds-"));
  try {
    const credentials = join(dir, "credentials.yaml");
    writeFileSync(credentials, [
      "android:",
      "  package_name: ${UNSET_SHIPUP_TEST_VALUE}",
      "ios:",
      "  app_id: '456'",
      "  private_key: fixture-key",
    ].join("\n"), { mode: 0o600 });
    chmodSync(credentials, 0o600);
    const ios = loadCreds(credentials, "ios");
    assert.equal(ios.app_id, "456");
    assert.equal(ios.private_key, "fixture-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
