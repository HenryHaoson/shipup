import assert from "node:assert/strict";
import test from "node:test";
import { IosAppStoreAdapter } from "../dist/adapters/ios/appstore/index.js";
import { AscClient } from "../dist/adapters/ios/appstore/asc.js";

const CTX = {
  appId: "app1", version: "2.0.46",
  creds: { key_id: "k", issuer_id: "i", private_key: "p" },
  phased: true, complete: false, pause: false, resume: false, timeoutMs: 1000,
};

async function withStub(appStoreState, phasedExists, fn) {
  const originals = {
    version: AscClient.prototype.getAppStoreVersion,
    getPhased: AscClient.prototype.getPhasedRelease,
    start: AscClient.prototype.startPhasedRelease,
    release: AscClient.prototype.requestRelease,
  };
  const calls = { start: 0, release: 0 };
  AscClient.prototype.getAppStoreVersion = async () => ({ id: "v1", attributes: { appStoreState } });
  AscClient.prototype.getPhasedRelease = async () => phasedExists
    ? { id: "ph1", attributes: { phasedReleaseState: "ACTIVE" } }
    : null;
  AscClient.prototype.startPhasedRelease = async () => { calls.start++; return {}; };
  AscClient.prototype.requestRelease = async () => { calls.release++; };
  try { await fn(calls); } finally {
    AscClient.prototype.getAppStoreVersion = originals.version;
    AscClient.prototype.getPhasedRelease = originals.getPhased;
    AscClient.prototype.startPhasedRelease = originals.start;
    AscClient.prototype.requestRelease = originals.release;
  }
}

test("MANUAL 待发布且无灰度时开启灰度并发布", async () => {
  await withStub("PENDING_DEVELOPER_RELEASE", false, async (calls) => {
    const res = await new IosAppStoreAdapter().release(CTX);
    assert.deepEqual(calls, { start: 1, release: 1 });
    assert.equal(res.status, "published");
    assert.equal(res.errorCode, null);
  });
});

test("MANUAL 待发布且已有灰度时只触发发布", async () => {
  await withStub("PENDING_DEVELOPER_RELEASE", true, async (calls) => {
    const res = await new IosAppStoreAdapter().release(CTX);
    assert.deepEqual(calls, { start: 0, release: 1 });
    assert.equal(res.status, "published");
  });
});

test("已上架且已有灰度时幂等跳过", async () => {
  await withStub("READY_FOR_SALE", true, async (calls) => {
    const res = await new IosAppStoreAdapter().release(CTX);
    assert.deepEqual(calls, { start: 0, release: 0 });
    assert.equal(res.status, "approved");
  });
});

test("审核前预置灰度时只创建灰度", async () => {
  await withStub("PREPARE_FOR_SUBMISSION", false, async (calls) => {
    const res = await new IosAppStoreAdapter().release(CTX);
    assert.deepEqual(calls, { start: 1, release: 0 });
    assert.equal(res.status, "approved");
  });
});
