import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseTag } from "../scripts/verify-release-tag.mjs";

test("verifyReleaseTag accepts the package version tag", () => {
  assert.equal(verifyReleaseTag("1.2.3", "v1.2.3"), "v1.2.3");
});

test("verifyReleaseTag rejects a mismatched tag", () => {
  assert.throws(
    () => verifyReleaseTag("1.2.3", "v1.2.4"),
    /does not match package version/,
  );
});

test("verifyReleaseTag rejects a missing tag", () => {
  assert.throws(() => verifyReleaseTag("1.2.3", ""), /RELEASE_TAG is missing/);
});
