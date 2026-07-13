import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { signQq } from "../dist/adapters/android/qq/api.js";
import { hmacSha256Hex } from "../dist/infra/crypto.js";
import { buildOutput, exitCodeFor } from "../dist/cli/output.js";
import { isRetryable } from "../dist/infra/http.js";
import { ExitCode } from "../dist/core/exit.js";
import { redactSensitive, UploadError } from "../dist/core/types.js";

test("QQ 签名按 key 升序拼接后使用 HMAC-SHA256", () => {
  const params = { b: "2", a: "1", user_id: "61204", timestamp: "100" };
  const expected = createHmac("sha256", "sek")
    .update("a=1&b=2&timestamp=100&user_id=61204")
    .digest("hex");
  assert.equal(signQq(params, "sek"), expected);
});

test("QQ 签名忽略 undefined 值", () => {
  assert.equal(signQq({ a: "1", x: undefined }, "s"), signQq({ a: "1" }, "s"));
});

test("QQ 签名排除空串", () => {
  assert.equal(signQq({ a: "1", e: "" }, "s"), signQq({ a: "1" }, "s"));
});

const result = (status, errorCode = null) => ({ channel: "c", action: "status", status, errorCode });

test("rejected/offline 是业务状态而不是操作失败", () => {
  const out = buildOutput("android", "status", [result("rejected"), result("offline")]);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.ok, true);
  assert.equal(exitCodeFor(out), ExitCode.OK);
});

test("failed/not_implemented 才算操作失败", () => {
  const out = buildOutput("android", "upload", [result("failed", "x"), result("published")]);
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.succeeded, 1);
  assert.equal(exitCodeFor(out), ExitCode.PARTIAL);
});

test("全部超时使用退出码 124", () => {
  const out = buildOutput("android", "upload", [result("failed", "timeout"), result("failed", "timeout")]);
  assert.equal(exitCodeFor(out), ExitCode.TIMEOUT);
});

test("非全超时的全部失败使用退出码 2", () => {
  const out = buildOutput("android", "upload", [result("failed", "timeout"), result("failed", "500")]);
  assert.equal(exitCodeFor(out), ExitCode.ALL_FAILED);
});

test("HTTP 只重试瞬时错误", () => {
  assert.equal(isRetryable(new UploadError(500, "x")), true);
  assert.equal(isRetryable(new UploadError(429, "x")), true);
  assert.equal(isRetryable(new UploadError(400, "x")), false);
  assert.equal(isRetryable(new UploadError("parse", "x")), false);
});

test("网络和超时错误可重试，普通错误不可重试", () => {
  const timeout = new Error("timeout");
  timeout.name = "TimeoutError";
  assert.equal(isRetryable(timeout), true);
  assert.equal(isRetryable(new Error("fetch failed")), true);
  assert.equal(isRetryable(new Error("业务校验失败")), false);
});

test("HMAC-SHA256 与 Node crypto 一致", () => {
  assert.equal(hmacSha256Hex("k", "data"), createHmac("sha256", "k").update("data").digest("hex"));
});

test("多市场错误日志会脱敏凭证和签名参数", () => {
  const text = redactSensitive(
    'Authorization: Bearer abc client_secret="secret-value" password=pwd123&access_token=token-value registeredIdNumber=91330000123456789X',
  );
  assert.doesNotMatch(text, /abc|secret-value|pwd123|token-value|91330000123456789X/);
  assert.match(text, /<redacted>/);
  const error = new UploadError(401, 'private_key="very-secret-private-key"');
  assert.doesNotMatch(error.message, /very-secret-private-key/);
});
