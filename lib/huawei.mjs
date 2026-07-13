// 华为应用市场（AppGallery，安卓 APK），Publish API v2。
// 发布链路：
//   取上传地址(upload-url?suffix=apk) → multipart 直传（authCode）→ app-file-info 绑定（fileType=5）
//   →（可选 newFeatures）→（可选 --submit-review：app-submit，204144727 处理中自动重试 ≤30 次）。
// 已知坑：取地址返回的字段拼写是 fileDestUlr，绑定接口要的是 fileDestUrl，序列化时统一修正。
import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  CliError, ExitCode, log, agc, agcAuth, fetchJson, sleep, resolveValue, AGC_API_BASE,
} from "./common.mjs";

const V2 = "/publish/v2";

// 华为安卓 releaseState → 归一化
export function mapReleaseState(state) {
  switch (state) {
    case 0: return ["published", "已上架"];
    case 1: case 8: case 9: case 13: return ["rejected", "审核不通过"];
    case 3: case 4: case 5: case 12: return ["pending_review", "审核/预审中"];
    case 2: case 6: case 10: case 11: return ["offline", "已下架/撤销"];
    case 7: return ["uploaded", "草稿"];
    default: return ["submitted", `releaseState=${state}（暂无更细状态）`];
  }
}

function requireAppId(creds) {
  if (!creds.app_id) throw new CliError(ExitCode.CREDS, "huawei 凭证缺少 app_id（AGC → 我的APP，安卓应用的 ID）");
}

/** multipart 直传文件到华为文件服务器，返回 fileInfoList。 */
async function uploadFileMultipart(auth, creds, bytes, fileName, deadline) {
  const suffix = fileName.split(".").pop();
  const { uploadUrl, authCode } = await agc("GET", `${V2}/upload-url`, {
    auth,
    query: { appId: creds.app_id, suffix },
  }, deadline);
  if (!uploadUrl || !authCode) throw new CliError(ExitCode.FAIL, "取上传地址响应缺少 uploadUrl/authCode");

  const form = new FormData();
  form.append("authCode", authCode);
  form.append("fileCount", "1");
  form.append("parseType", "0");
  form.append("file", new Blob([bytes]), fileName);

  // 不手动设 Content-Type，交给 fetch 生成 multipart boundary
  const data = await fetchJson(uploadUrl, { method: "POST", headers: { ...auth }, body: form }, deadline);
  const rsp = data?.result?.UploadFileRsp;
  if (!rsp || !Array.isArray(rsp.fileInfoList) || rsp.fileInfoList.length === 0) {
    throw new CliError(ExitCode.FAIL, `上传响应缺少 fileInfoList: ${JSON.stringify(rsp ?? data).slice(0, 300)}`);
  }
  rsp.fileInfoList[0].fileName = fileName;
  return rsp.fileInfoList;
}

/** app-file-info 绑定（华为接口要 fileDestUrl，上游返回的是拼写错误的 fileDestUlr，需修正）。 */
async function bindFileInfo(auth, creds, fileType, files, deadline) {
  const serialized = JSON.stringify({ fileType, files, lang: "zh-CN" }).replace(/fileDestUlr/g, "fileDestUrl");
  const res = await fetchJson(`${AGC_API_BASE}${V2}/app-file-info?appId=${creds.app_id}`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: serialized,
  }, deadline);
  if (res.ret && Number(res.ret.code) !== 0) {
    throw new CliError(ExitCode.FAIL, `app-file-info 失败: [${res.ret.code}] ${res.ret.msg}`, String(res.ret.code));
  }
}

async function updateReleaseNote(creds, auth, opts, deadline) {
  const lang = opts.lang || creds.default_lang || "zh-CN";
  const note = resolveValue(opts.releaseNote, process.cwd());
  if (note.length > 500) throw new CliError(ExitCode.USAGE, `release note 超长（${note.length} > 500）`);
  await agc("PUT", `${V2}/app-language-info`, {
    auth,
    query: { appId: creds.app_id },
    body: { lang, newFeatures: note },
  }, deadline);
  log(`✓ 已更新 newFeatures（${lang}，${note.length} 字）`);
  return { lang, length: note.length };
}

/** 提交审核：ret.code==0 成功；204144727 表示服务端处理中，2s 后重试（≤30 次）。 */
async function submitReview(creds, auth, deadline) {
  const body = { requestId: creds.package_name || String(Date.now()) };
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetchJson(`${AGC_API_BASE}${V2}/app-submit?appId=${creds.app_id}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, deadline);
    const code = Number(res?.ret?.code ?? -1);
    if (code === 0) return;
    if (code === 204144727) {
      log("  … 服务端处理中，2s 后重试提审");
      await sleep(2000, deadline);
      continue;
    }
    throw new CliError(ExitCode.FAIL, `提交审核失败: [${code}] ${res?.ret?.msg ?? ""}`, String(code));
  }
  throw new CliError(ExitCode.FAIL, "提交审核失败：处理中状态重试超过 30 次", "204144727");
}

export async function upload(creds, opts, deadline) {
  requireAppId(creds);
  const pkgPath = resolve(opts.package);
  if (!existsSync(pkgPath)) throw new CliError(ExitCode.MISSING_INPUT, `APK 不存在: ${pkgPath}`);
  if (!pkgPath.endsWith(".apk")) throw new CliError(ExitCode.MISSING_INPUT, "huawei upload 只接受 .apk");
  const bytes = readFileSync(pkgPath);
  log(`APK: ${basename(pkgPath)}（${(bytes.length / 1024 / 1024).toFixed(1)}MB）`);

  if (opts.dryRun) {
    log(`[dry-run] 将上传到 appId=${creds.app_id}${opts.submitReview ? " 并提交审核" : ""}，不发请求`);
    return { status: "skipped", message: "dry-run" };
  }

  const auth = await agcAuth(creds, deadline);
  log("上传 APK …");
  const files = await uploadFileMultipart(auth, creds, bytes, basename(pkgPath), deadline);
  await bindFileInfo(auth, creds, 5, files, deadline);
  log("✓ APK 已上传并绑定");

  let noteInfo;
  if (opts.releaseNote) noteInfo = await updateReleaseNote(creds, auth, opts, deadline);

  if (opts.submitReview) {
    await submitReview(creds, auth, deadline);
    log("✓ 已提交审核");
    return { status: "submitted", releaseNote: noteInfo };
  }
  log("（未提审：加 --submit-review 或稍后在 AGC 网页提交）");
  return { status: "uploaded", releaseNote: noteInfo };
}

export async function status(creds, opts, deadline) {
  requireAppId(creds);
  if (opts.dryRun) return { status: "skipped", message: "dry-run" };
  const auth = await agcAuth(creds, deadline);
  const res = await agc("GET", `${V2}/app-info`, { auth, query: { appId: creds.app_id } }, deadline);
  const a = res?.appInfo ?? res ?? {};
  const raw = a.releaseState === undefined || a.releaseState === null || a.releaseState === "" ? null : Number(a.releaseState);
  const [normalized, label] = mapReleaseState(raw);
  const auditOpinion = res?.auditInfo?.auditOpinion || "";
  log(`releaseState=${raw}（${label}）`);
  log(`  提审版本: ${a.versionNumber ?? "-"}  在架版本: ${a.onShelfVersionNumber ?? "-"}`);
  if (auditOpinion) log(`  审核意见: ${auditOpinion}`);
  return {
    status: normalized,
    message: label,
    releaseState: raw,
    versionName: a.versionNumber,
    onShelfVersionName: a.onShelfVersionNumber,
    auditOpinion,
  };
}
