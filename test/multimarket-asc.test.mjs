import assert from "node:assert/strict";
import test from "node:test";
import { AscClient } from "../dist/adapters/ios/appstore/asc.js";
import { UploadError } from "../dist/core/types.js";

const CREDS = { keyId: "k", issuerId: "i", privateKey: "p" };

function clientWith(responses) {
  const client = new AscClient(CREDS);
  let index = 0;
  client.ascFetch = async () => responses[Math.min(index++, responses.length - 1)];
  return client;
}

async function withoutProgress(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

test("ASC build 一直不存在时快速失败", async () => {
  await withoutProgress(async () => {
    const client = clientWith([{ data: [] }]);
    await assert.rejects(
      client.waitBuildValid("app", "2", "2.0.46", Date.now() + 60_000, 1, 1),
      (error) => error.code === "build_not_found" && /找不到 build 2\(2\.0\.46\)/.test(error.message),
    );
  });
});

test("ASC build 从 PROCESSING 进入 VALID", async () => {
  await withoutProgress(async () => {
    const client = clientWith([
      { data: [{ id: "b1", attributes: { processingState: "PROCESSING" } }] },
      { data: [{ id: "b1", attributes: { processingState: "VALID" } }] },
    ]);
    assert.equal(await client.waitBuildValid("app", "2", "2.0.46", Date.now() + 60_000, 1, 1), "b1");
  });
});

test("ASC 首轮命中 VALID build", async () => {
  const client = clientWith([{ data: [{ id: "b9", attributes: { processingState: "VALID" } }] }]);
  assert.equal(await client.waitBuildValid("app", "2", "2.0.46", Date.now() + 60_000, 1, 1), "b9");
});

test("ASC FAILED build 抛出 UploadError", async () => {
  const client = clientWith([{ data: [{ id: "b2", attributes: { processingState: "FAILED" } }] }]);
  await assert.rejects(
    client.waitBuildValid("app", "2", "2.0.46", Date.now() + 60_000, 1, 1),
    UploadError,
  );
});
