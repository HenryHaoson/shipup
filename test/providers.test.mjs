import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapReleaseState as mapHarmonyState, readPackInfo } from "../lib/harmony.mjs";
import { mapReleaseState as mapHuaweiState } from "../lib/huawei.mjs";
import { buildLocaleMap, mapAppStoreState } from "../lib/ios.mjs";
import { storedZip } from "./helpers.mjs";

test("provider states normalize to the shared vocabulary", () => {
  assert.equal(mapHarmonyState(0)[0], "published");
  assert.equal(mapHarmonyState(12)[0], "pending_review");
  assert.equal(mapHarmonyState(999)[0], "failed");
  assert.equal(mapHuaweiState(0)[0], "published");
  assert.equal(mapHuaweiState(13)[0], "rejected");
  assert.equal(mapAppStoreState("READY_FOR_SALE"), "published");
  assert.equal(mapAppStoreState("WAITING_FOR_REVIEW"), "pending_review");
  assert.equal(mapAppStoreState("UNKNOWN"), "failed");
});

test("Harmony package metadata is read from pack.info", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipup-pack-"));
  try {
    const file = join(dir, "sample.app");
    const packInfo = {
      summary: {
        app: {
          bundleName: "com.example.app",
          version: { name: "1.2.3", code: 123 },
        },
      },
    };
    writeFileSync(file, storedZip("pack.info", JSON.stringify(packInfo)));
    assert.deepEqual(readPackInfo(file), {
      bundleName: "com.example.app",
      versionName: "1.2.3",
      versionCode: 123,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("App Store metadata supports locale sections and file values", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipup-metadata-"));
  try {
    writeFileSync(join(dir, "note.txt"), "Release notes\n");
    const metadata = join(dir, "metadata.yaml");
    writeFileSync(metadata, [
      "en-US:",
      "  whatsNew: @note.txt",
      "  keywords: maps,privacy",
      "zh-Hans:",
      "  whatsNew: 新版本",
    ].join("\n"));
    assert.deepEqual(buildLocaleMap({ metadata }, dir), {
      "en-US": { whatsNew: "Release notes", keywords: "maps,privacy" },
      "zh-Hans": { whatsNew: "新版本" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
