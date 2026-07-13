// AppGallery Connect Publishing API v3（HarmonyOS 应用/元服务 .app 包）。
// 链路：预签名 OBS 传包 → app-package-info 登记 → 轮询编译解析 → （可选 newFeatures）→ app-submit 提审。
// 依据官方 2026-06-25 版文档（agc-help-publish-api-guide-0000002271134665）。
import { createHash } from "node:crypto";
import { readFileSync, statSync, createReadStream, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { request as httpsRequest } from "node:https";
import {
  CliError, ExitCode, log, agc, agcAuth, sleep, remainingMs, resolveValue, readZipEntry,
} from "./common.mjs";

// releaseState（releaseType=1 全网）→ 归一化状态
const RELEASE_STATE = {
  0: ["published", "已上架"],
  1: ["rejected", "上架审核不通过"],
  2: ["offline", "已下架（含强制下架）"],
  3: ["approved", "待上架（预约上架）"],
  4: ["pending_review", "审核中"],
  5: ["pending_review", "升级审核中"],
  6: ["pending_review", "申请下架（下架审核中）"],
  7: ["draft", "草稿"],
  8: ["rejected", "升级审核不通过"],
  9: ["rejected", "下架审核不通过"],
  10: ["offline", "应用被开发者下架"],
  11: ["skipped", "撤销上架"],
  12: ["pending_review", "预审中"],
  13: ["rejected", "预审不通过"],
};

function requireAppId(creds) {
  if (!creds.app_id) throw new CliError(ExitCode.CREDS, "harmony 凭证缺少 app_id（AGC → 我的APP → 查看应用信息）");
}

export function mapReleaseState(state) {
  return RELEASE_STATE[state] ?? ["failed", `未知 releaseState=${state}`];
}

export function readPackInfo(filePath) {
  try {
    const raw = readZipEntry(readFileSync(filePath), "pack.info");
    const app = raw && JSON.parse(raw.toString("utf8"))?.summary?.app;
    return app ? { bundleName: app.bundleName, versionName: app.version?.name, versionCode: app.version?.code } : null;
  } catch {
    return null;
  }
}

// 预签名 OBS PUT：流式上传，原样回放 urlInfo.headers
function obsUpload(urlInfo, filePath, size, deadline) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(new URL(urlInfo.url), {
      method: urlInfo.method || "PUT",
      headers: { ...(urlInfo.headers ?? {}), "Content-Length": size },
      timeout: remainingMs(deadline),
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode === 200) resolvePromise();
        else reject(new CliError(ExitCode.FAIL, `文件上传失败 HTTP ${res.statusCode}: ${body.slice(0, 300)}`, String(res.statusCode)));
      });
    });
    req.on("timeout", () => req.destroy(new Error("upload timeout")));
    req.on("error", (e) => reject(new CliError(ExitCode.FAIL, `文件上传失败: ${e.message}`)));
    createReadStream(filePath).on("error", (e) => req.destroy(e)).pipe(req);
  });
}

async function updateReleaseNote(creds, auth, opts, deadline) {
  const lang = opts.lang || creds.default_lang || "zh-CN";
  const note = resolveValue(opts.releaseNote, process.cwd());
  if (note.length > 500) throw new CliError(ExitCode.USAGE, `release note 超长（${note.length} > 500）`);
  await agc("PUT", "/publish/v3/app-language-info", {
    auth,
    query: { appId: creds.app_id },
    body: { lang, newFeatures: note },
  }, deadline);
  log(`✓ 已更新 newFeatures（${lang}，${note.length} 字）`);
  return { lang, length: note.length };
}

export async function upload(creds, opts, deadline) {
  requireAppId(creds);
  const pkgPath = resolve(opts.package);
  if (!existsSync(pkgPath)) throw new CliError(ExitCode.MISSING_INPUT, `软件包不存在: ${pkgPath}`);
  const size = statSync(pkgPath).size;
  const info = readPackInfo(pkgPath);
  if (info) {
    log(`软件包: ${basename(pkgPath)}（${(size / 1024 / 1024).toFixed(1)}MB）`);
    log(`  bundleName=${info.bundleName} versionName=${info.versionName} versionCode=${info.versionCode}`);
    if (creds.package_name && info.bundleName !== creds.package_name) {
      throw new CliError(ExitCode.MISSING_INPUT,
        `包名不匹配: 软件包是 ${info.bundleName}，凭证 package_name 是 ${creds.package_name}（防止传错 app）`);
    }
  } else {
    log(`软件包: ${basename(pkgPath)}（${(size / 1024 / 1024).toFixed(1)}MB）— pack.info 解析失败，跳过包名校验`);
  }

  if (opts.dryRun) {
    log(`[dry-run] 将上传到 appId=${creds.app_id}，不发请求`);
    return { status: "skipped", message: "dry-run", ...info };
  }

  log("计算 SHA256 …");
  const sha256 = createHash("sha256").update(readFileSync(pkgPath)).digest("hex");
  const auth = await agcAuth(creds, deadline);

  log("获取上传地址 …");
  const query = { appId: creds.app_id, fileName: basename(pkgPath), contentLength: String(size), sha256 };
  if (creds.chinese_mainland_flag) query.chineseMainlandFlag = creds.chinese_mainland_flag;
  const { urlInfo } = await agc("GET", "/publish/v2/upload-url/for-obs", { auth, query }, deadline);

  log("上传软件包 …");
  await obsUpload(urlInfo, pkgPath, size, deadline);
  log("✓ 上传完成");

  const { packageId } = await agc("PUT", "/publish/v3/app-package-info", {
    auth,
    query: { appId: creds.app_id },
    body: { fileName: basename(pkgPath), objectId: urlInfo.objectId },
  }, deadline);
  log(`✓ 软件包已登记 packageId=${packageId}`);

  if (!opts.noWait) {
    log("等待编译解析（约 2 分钟）…");
    for (;;) {
      await sleep(15_000, deadline);
      const { pkgStateList } = await agc("GET", "/publish/v3/package/compile/status", {
        auth,
        query: { appId: creds.app_id, pkgIds: packageId },
      }, deadline);
      const state = pkgStateList?.[0]?.successStatus;
      if (state === 0) { log("✓ 解析正常，可提交审核"); break; }
      if (state === 2) throw new CliError(ExitCode.FAIL, "软件包解析失败（successStatus=2），该包不可用", "compile_failed");
      log("  … 解析中");
    }
  }

  let noteInfo;
  if (opts.releaseNote) noteInfo = await updateReleaseNote(creds, auth, opts, deadline);

  return { status: "uploaded", packageId, ...info, releaseNote: noteInfo };
}

export async function submit(creds, opts, deadline) {
  requireAppId(creds);
  const body = { releaseType: 1, releasePhase: opts.phased ? 3 : 0 };
  if (opts.remark) body.remark = opts.remark;
  if (opts.releaseTime) body.releaseTime = opts.releaseTime;
  if (opts.phased) body.phasedReleaseDescription = opts.phasedDesc;

  if (opts.dryRun) {
    log(`[dry-run] 将提交发布 appId=${creds.app_id} body=${JSON.stringify(body)}`);
    return { status: "skipped", message: "dry-run" };
  }
  const auth = await agcAuth(creds, deadline);
  let noteInfo;
  if (opts.releaseNote) noteInfo = await updateReleaseNote(creds, auth, opts, deadline);

  await agc("POST", "/publish/v3/app-submit", { auth, query: { appId: creds.app_id }, body }, deadline);
  log(`✓ 已提交审核（${opts.phased ? "分阶段发布" : "全网发布"}${opts.releaseTime ? `，上架时间 ${opts.releaseTime}` : ""}）`);
  return { status: "submitted", phased: !!opts.phased, releaseNote: noteInfo };
}

export async function status(creds, opts, deadline) {
  requireAppId(creds);
  if (opts.dryRun) return { status: "skipped", message: "dry-run" };
  const auth = await agcAuth(creds, deadline);
  const res = await agc("GET", "/publish/v3/app-info", {
    auth,
    query: { appId: creds.app_id, lang: opts.lang || creds.default_lang || "zh-CN" },
  }, deadline);
  const a = res.appInfo ?? {};
  const [normalized, label] = mapReleaseState(a.releaseState);
  const auditOpinion = res.auditInfo?.auditOpinion || "";
  log(`releaseState=${a.releaseState}（${label}）`);
  log(`  提审版本: ${a.versionNumber ?? "-"}（versionCode=${a.versionCode ?? "-"}）  在架版本: ${a.onShelfVersionNumber ?? "-"}`);
  if (auditOpinion) log(`  审核意见: ${auditOpinion}`);
  return {
    status: normalized,
    message: label,
    releaseState: a.releaseState,
    versionName: a.versionNumber,
    versionCode: a.versionCode,
    onShelfVersionName: a.onShelfVersionNumber,
    reviewState: a.reviewState,
    auditOpinion,
    releaseTime: a.releaseTime,
  };
}
