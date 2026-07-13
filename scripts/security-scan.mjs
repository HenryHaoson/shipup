import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
// Tests contain deliberately fake credential-shaped strings to verify redaction.
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "test"]);
const allowedFiles = new Set(["creds.example.yaml"]);
const forbiddenNames = [
  /^creds(?:\.[^.]+)?\.ya?ml$/i,
  /authkey_[a-z0-9]+\.p8$/i,
  /(?:service-account|private).*\.json$/i,
];
const forbiddenContent = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /["'](?:access_token|client_secret|private_key)["']\s*:\s*["'](?!<redacted>|\$\{|@|fake-|test-)[^"']{8,}["']/i,
  /\b(?:ghp|github_pat|glpat)-?[A-Za-z0-9_-]{20,}\b/,
];

function filesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

const findings = [];
for (const file of filesUnder(root)) {
  const name = basename(file);
  const display = relative(root, file);
  if (!allowedFiles.has(name) && forbiddenNames.some((pattern) => pattern.test(name))) {
    findings.push(`${display}: forbidden credential filename`);
  }
  if (name === "package-lock.json" || name.endsWith(".tgz")) continue;
  const content = readFileSync(file, "utf8");
  for (const pattern of forbiddenContent) {
    if (pattern.test(content)) findings.push(`${display}: content matched ${pattern}`);
  }
}

if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exit(1);
}

console.log("security scan passed");
