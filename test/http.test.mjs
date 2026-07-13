import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { CliError, fetchJson } from "../lib/common.mjs";

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("fetchJson retries transient failures only when requested", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls += 1;
    res.setHeader("Content-Type", "application/json");
    if (calls < 3) {
      res.statusCode = 500;
      res.end('{"error":"temporary"}');
    } else {
      res.end('{"ok":true}');
    }
  }, async (base) => {
    const result = await fetchJson(`${base}/status`, { method: "GET" }, Date.now() + 10_000, { retries: 2 });
    assert.deepEqual(result, { ok: true });
  });
  assert.equal(calls, 3);
});

test("fetchJson redacts provider secrets and signed query strings", async () => {
  await withServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end('{"access_token":"must-not-leak","detail":"denied"}');
  }, async (base) => {
    await assert.rejects(
      fetchJson(`${base}/upload?signature=must-not-leak`, { method: "GET" }, Date.now() + 5_000),
      (error) => {
        assert.ok(error instanceof CliError);
        assert.doesNotMatch(error.message, /must-not-leak|signature=/);
        assert.match(error.message, /<redacted>/);
        return true;
      },
    );
  });
});
