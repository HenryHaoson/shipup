import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function verifyReleaseTag(version, releaseTag) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version is missing");
  }
  if (typeof releaseTag !== "string" || releaseTag.length === 0) {
    throw new Error("RELEASE_TAG is missing");
  }

  const expectedTag = `v${version}`;
  if (releaseTag !== expectedTag) {
    throw new Error(`release tag ${releaseTag} does not match package version ${expectedTag}`);
  }

  return expectedTag;
}

export function main() {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const tag = verifyReleaseTag(packageJson.version, process.env.RELEASE_TAG);
  console.log(`release tag verified: ${tag}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
