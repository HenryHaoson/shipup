import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isHuaweiDraftOnShelfUpgrade,
  normalizeHuaweiRegistrationInfo,
  resolveHuaweiReleasePlan,
  uploadHuawei,
} from "../dist/adapters/android/huawei/api.js";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

async function withTempApk(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const apkPath = join(dir, "app.apk");
  await writeFile(apkPath, Buffer.from("apk"));
  try {
    await fn(apkPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Huawei auto continues active and suspended phased releases", () => {
  for (const state of ["RELEASE", "SUSPEND"]) {
    const plan = resolveHuaweiReleasePlan({
      options: { mode: "auto" },
      releaseNote: "修复线上问题",
      currentPhasedReleaseInfo: {
        state,
        phasedReleaseStartTime: "2026-07-01T00:00:00+0800",
        phasedReleaseEndTime: "2026-07-31T00:00:00+0800",
        phasedReleasePercent: "5",
        phasedReleaseDescription: "旧说明",
      },
    });
    assert.deepEqual(plan, {
      mode: "phased",
      releaseType: 3,
      phasedReleaseInfo: {
        phasedReleaseStartTime: "2026-07-01T00:00:00+0800",
        phasedReleaseEndTime: "2026-07-31T00:00:00+0800",
        phasedReleasePercent: "5.00",
        phasedReleaseDescription: "修复线上问题",
      },
    });
  }
});

test("Huawei auto stays full without an active phased release", () => {
  assert.deepEqual(
    resolveHuaweiReleasePlan({
      options: { mode: "auto" },
      currentPhasedReleaseInfo: { state: "CANCEL" },
    }),
    { mode: "full", releaseType: 1 },
  );
});

test("Huawei explicit phased mode requires a complete schedule", () => {
  assert.throws(
    () => resolveHuaweiReleasePlan({ options: { mode: "phased" } }),
    /--huawei-phased-start/,
  );
});

test("Huawei identifies only draft slots targeting a different on-shelf version", () => {
  const base = {
    info: { state: "DRAFT", phasedReleasePercent: "50" },
    phasedReleaseState: 7,
    fullOnShelfVersion: "6.3.303",
  };
  assert.equal(
    isHuaweiDraftOnShelfUpgrade({ ...base, phasedOnShelfVersion: "6.3.403" }),
    true,
  );
  assert.equal(
    isHuaweiDraftOnShelfUpgrade({ ...base, phasedOnShelfVersion: "6.3.303" }),
    false,
  );
  assert.equal(
    isHuaweiDraftOnShelfUpgrade({
      ...base,
      info: { state: "DRAFT" },
      phasedOnShelfVersion: "6.3.403",
    }),
    false,
  );
});

test("Huawei organizer type and identifier must be configured together", () => {
  assert.deepEqual(
    normalizeHuaweiRegistrationInfo({
      registeredIdType: "1",
      registeredIdNumber: " 91330000123456789X ",
    }),
    { registeredIdType: 1, registeredIdNumber: "91330000123456789X" },
  );
  assert.throws(
    () => normalizeHuaweiRegistrationInfo({ registeredIdType: "1" }),
    /必须同时配置/,
  );
  assert.throws(
    () => normalizeHuaweiRegistrationInfo({ registeredIdType: "4", registeredIdNumber: "x" }),
    /仅支持 1（企业）、2（个人）、3（机构）/,
  );
});

test("Huawei active phased uploads propagate releaseType=3 through every write", async () => {
  await withTempApk("shipup-huawei-", async (apkPath) => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const versionRequests = [];
    let submitBody;
    console.error = () => {};
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/v1/token")) {
        return jsonResponse({ access_token: "token" });
      }
      if (url.hostname === "upload.example.com") {
        return jsonResponse({
          result: {
            UploadFileRsp: {
              fileInfoList: [{ fileDestUlr: "https://file.example.com/app.apk", size: 3 }],
            },
          },
        });
      }
      versionRequests.push({ url, init });
      if (url.pathname.endsWith("/app-info") && init?.method === "GET") {
        return jsonResponse({
          ret: { code: 0, msg: "success" },
          phasedReleaseInfo: {
            state: "RELEASE",
            phasedReleaseStartTime: "2026-07-01T00:00:00+0800",
            phasedReleaseEndTime: "2026-07-31T00:00:00+0800",
            phasedReleasePercent: "10.00",
            phasedReleaseDescription: "old",
          },
        });
      }
      if (url.pathname.endsWith("/upload-url")) {
        return jsonResponse({ uploadUrl: "https://upload.example.com/file", authCode: "auth" });
      }
      if (url.pathname.endsWith("/app-submit")) submitBody = JSON.parse(String(init?.body));
      return jsonResponse({ ret: { code: 0, msg: "success" } });
    };

    try {
      await uploadHuawei({
        appId: "app-id",
        clientId: "client-id",
        clientSecret: "secret",
        apkPath,
        packageName: "com.example.app",
        releaseNote: "修复问题",
        timeoutMs: 10_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }

    assert.deepEqual(versionRequests.map((request) => request.url.pathname), [
      "/api/publish/v2/app-info",
      "/api/publish/v2/upload-url",
      "/api/publish/v2/app-file-info",
      "/api/publish/v2/app-language-info",
      "/api/publish/v2/app-submit",
    ]);
    assert.equal(versionRequests[0].url.searchParams.get("releaseType"), "1");
    for (const request of versionRequests.slice(1)) {
      assert.equal(request.url.searchParams.get("releaseType"), "3");
    }
    assert.deepEqual(submitBody, {
      requestId: "com.example.app",
      phasedReleaseStartTime: "2026-07-01T00:00:00+0800",
      phasedReleaseEndTime: "2026-07-31T00:00:00+0800",
      phasedReleasePercent: "10.00",
      phasedReleaseDescription: "修复问题",
    });
  });
});

test("Huawei refreshes stale draft phased schedules immediately before submission", async () => {
  await withTempApk("shipup-huawei-draft-", async (apkPath) => {
    const originalFetch = globalThis.fetch;
    const OriginalDate = globalThis.Date;
    const originalError = console.error;
    let now = OriginalDate.parse("2026-07-13T08:20:27Z");
    let submitBody;
    const logs = [];

    class FakeDate extends OriginalDate {
      constructor(value) {
        if (arguments.length === 0) super(now);
        else super(value);
      }
      static now() {
        return now;
      }
    }

    globalThis.Date = FakeDate;
    console.error = (message) => logs.push(String(message));
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/v1/token")) {
        return jsonResponse({ access_token: "token" });
      }
      if (url.hostname === "upload.example.com") {
        return jsonResponse({
          result: {
            UploadFileRsp: {
              fileInfoList: [{ fileDestUlr: "https://file.example.com/app.apk", size: 3 }],
            },
          },
        });
      }
      if (url.pathname.endsWith("/app-info") && init?.method === "GET") {
        if (url.searchParams.get("releaseType") === "1") {
          return jsonResponse({
            ret: { code: 0, msg: "success" },
            appInfo: {
              releaseState: 0,
              versionNumber: "6.3.303",
              onShelfVersionNumber: "6.3.303",
            },
          });
        }
        return jsonResponse({
          ret: { code: 0, msg: "success" },
          appInfo: {
            releaseState: 7,
            versionNumber: "6.3.404",
            onShelfVersionNumber: "6.3.403",
          },
          phasedReleaseInfo: {
            state: "DRAFT",
            phasedReleaseStartTime: "2026-07-13T08:30:27+0000",
            phasedReleaseEndTime: "2026-07-20T08:30:27+0000",
            phasedReleasePercent: "50",
          },
        });
      }
      if (url.pathname.endsWith("/upload-url")) {
        return jsonResponse({ uploadUrl: "https://upload.example.com/file", authCode: "auth" });
      }
      if (url.pathname.endsWith("/app-language-info")) {
        now = OriginalDate.parse("2026-07-13T08:40:27Z");
      }
      if (url.pathname.endsWith("/app-submit")) submitBody = JSON.parse(String(init?.body));
      return jsonResponse({ ret: { code: 0, msg: "success" } });
    };

    try {
      await uploadHuawei({
        appId: "app-id",
        clientId: "client-id",
        clientSecret: "secret",
        apkPath,
        packageName: "com.example.app",
        releaseNote: "修复问题",
        timeoutMs: 10_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.Date = OriginalDate;
      console.error = originalError;
    }

    assert.deepEqual(submitBody, {
      requestId: "com.example.app",
      phasedReleaseStartTime: "2026-07-13T08:50:27+0000",
      phasedReleaseEndTime: "2026-07-20T08:50:27+0000",
      phasedReleasePercent: "50.00",
      phasedReleaseDescription: "修复问题",
    });
    assert.match(logs.join("\n"), /DRAFT_ON_SHELF_UPGRADE/);
    assert.match(logs.join("\n"), /scheduleAction=refreshed/);
  });
});

test("Huawei updates organizer data without exposing the identifier in logs", async () => {
  await withTempApk("shipup-huawei-registration-", async (apkPath) => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const logs = [];
    let registrationBody;
    console.error = (message) => logs.push(String(message));
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/v1/token")) {
        return jsonResponse({ access_token: "token" });
      }
      if (url.hostname === "upload.example.com") {
        return jsonResponse({
          result: {
            UploadFileRsp: {
              fileInfoList: [{ fileDestUlr: "https://file.example.com/app.apk", size: 3 }],
            },
          },
        });
      }
      if (url.pathname.endsWith("/app-info") && init?.method === "GET") {
        return jsonResponse({
          ret: { code: 0, msg: "success" },
          appInfo: { releaseState: 7, versionNumber: "1.8.202" },
        });
      }
      if (url.pathname.endsWith("/upload-url")) {
        return jsonResponse({ uploadUrl: "https://upload.example.com/file", authCode: "auth" });
      }
      if (url.pathname.endsWith("/app-info") && init?.method === "PUT") {
        registrationBody = JSON.parse(String(init.body));
      }
      return jsonResponse({ ret: { code: 0, msg: "success" } });
    };

    try {
      await uploadHuawei({
        appId: "app-id",
        clientId: "client-id",
        clientSecret: "secret",
        apkPath,
        packageName: "com.example.app",
        releaseNote: "修复问题",
        registeredIdType: "1",
        registeredIdNumber: "91330000123456789X",
        timeoutMs: 10_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }

    assert.deepEqual(registrationBody, {
      registeredIdType: 1,
      registeredIdNumber: "91330000123456789X",
    });
    assert.match(logs.join("\n"), /请求阶段=update-registration releaseType=1/);
    assert.doesNotMatch(logs.join("\n"), /91330000123456789X/);
  });
});
