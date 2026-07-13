import assert from "node:assert/strict";
import test from "node:test";
import { signVivo, syncUpdateApp } from "../dist/adapters/android/vivo/api.js";

test("vivo multipart 签名使用实际发送的 CRLF 多行文本", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let requested = false;

  Date.now = () => 1_700_000_000_000;
  globalThis.fetch = async (_url, init) => {
    requested = true;
    assert.ok(init.body instanceof FormData);

    const params = {};
    for (const [key, value] of init.body.entries()) {
      assert.equal(typeof value, "string");
      params[key] = String(value);
    }

    const signature = params.sign;
    delete params.sign;
    assert.equal(params.updateDesc, "第一行\r\n第二行\r\n第三行\r\n第四行");
    assert.equal(signature, signVivo(params, "secret"));

    return new Response(JSON.stringify({ code: 0, subCode: "0", msg: "成功" }), {
      status: 200,
    });
  };

  try {
    await syncUpdateApp({
      accessKey: "access-key",
      accessSecret: "secret",
      packageName: "com.example.app",
      versionCode: "123",
      apkMd5: "0123456789abcdef0123456789abcdef",
      apkSerialNumber: "apk-serial",
      updateDesc: "第一行\n第二行\r第三行\r\n第四行",
      timeoutMs: 10_000,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }

  assert.equal(requested, true);
});

test("vivo 重签时不把旧 sign 参与签名", () => {
  assert.equal(
    signVivo({ a: "1", sign: "old-signature" }, "secret"),
    signVivo({ a: "1" }, "secret"),
  );
});
