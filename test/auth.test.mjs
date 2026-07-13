import assert from "node:assert/strict";
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import test from "node:test";
import { serviceAccountAuth } from "../lib/common.mjs";
import { makeAscToken } from "../lib/ios.mjs";

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

test("AGC service-account auth creates a verifiable PS256 bearer token", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const headers = serviceAccountAuth({
    key_id: "test-key",
    sub_account: "test-account",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const token = headers.Authorization.replace(/^Bearer /, "");
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  assert.equal(decodeJson(headerSegment).alg, "PS256");
  assert.equal(decodeJson(payloadSegment).iss, "test-account");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      {
        key: publicKey,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      Buffer.from(signatureSegment, "base64url"),
    ),
    true,
  );
});

test("App Store Connect auth creates a verifiable ES256 JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = makeAscToken({
    key_id: "test-key",
    issuer_id: "test-issuer",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const [headerSegment, payloadSegment, signatureSegment] = token.split(".");
  assert.equal(decodeJson(headerSegment).alg, "ES256");
  assert.equal(decodeJson(payloadSegment).iss, "test-issuer");
  assert.equal(Buffer.from(signatureSegment, "base64url").length, 64);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureSegment, "base64url"),
    ),
    true,
  );
});
