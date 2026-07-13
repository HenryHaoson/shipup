// 退出码（与需求文档 §3.4.6 一致）
export const ExitCode = {
  OK: 0, // 全部成功
  PARTIAL: 1, // 部分渠道失败
  ALL_FAILED: 2, // 全部失败
  USAGE: 3, // 参数 / 用法错误
  CREDS: 4, // 凭证缺失或无效
  INPUT: 5, // 输入包文件不存在 / 不可读
  TIMEOUT: 124, // 超时
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** 用法错误：参数不合法时抛出，CLI 层捕获后以 USAGE 退出 */
export class UsageError extends Error {}
/** 凭证错误 */
export class CredsError extends Error {}
/** 输入错误（包文件缺失等） */
export class InputError extends Error {}
