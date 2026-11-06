// 飞书消息里的图片/文件 → ash 的上传目录（走 POST /api/uploads，归属与上限照网页上传的算）。
//
// 转存后的路径记在 im_inbound.attachments 上：同一条飞书消息重试处理时用同一份路径，
// 不会重复下载，送进 chat 的正文也逐字节相同（chat 的消息幂等要求正文一致）。
import { extname } from "node:path";
import type { ImPrincipal } from "../auth/im-actor.js";
import { failureOf, type AshClient } from "./ash-client.js";
import type { FeishuApi } from "./feishu/api.js";
import { isQuotaBlocked } from "./feishu/api.js";
import type { ParsedMessage } from "./feishu/message.js";

// 飞书下载接口的单文件上限是 100MB；ash 的上传上限按类型（图片 5MB、其它 20MB），超了
// 由上传接口如实回 413，这里不另设一道。
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".zip": "application/zip", ".log": "text/plain",
};

export interface SavedAttachments {
  paths: string[];
  /** 没转存成功的（太大、类型不收、额度见底）：回给用户一句说明。 */
  failures: string[];
  /**
   * 有一个只是这一下没下载 / 没转存成功（网络、5xx、限流）。这时不能当它没有、只发文字：答复会把那道题用掉，
   * 发给任务、投进房间的也少了附件，事后收不回来。调用方据此整句不发，请他再发一次。
   */
  transient: boolean;
}

export async function saveAttachments(
  api: FeishuApi,
  ash: AshClient,
  principal: ImPrincipal,
  messageId: string,
  attachments: ParsedMessage["attachments"],
): Promise<SavedAttachments> {
  const out: SavedAttachments = { paths: [], failures: [], transient: false };
  for (const item of attachments.slice(0, 10)) {
    const label = item.name ?? (item.kind === "image" ? "图片" : "文件");
    const downloaded = await api.download(messageId, item.key, item.kind);
    if (!downloaded.ok) {
      out.failures.push(`${label}：${isQuotaBlocked(downloaded) ? "本月飞书额度见底，没下载" : `下载失败（${downloaded.msg}）`}`);
      if (downloaded.retryable && !isQuotaBlocked(downloaded)) out.transient = true;
      continue;
    }
    if (!(downloaded.data?.bytes instanceof Uint8Array)) {
      out.failures.push(`${label}：下载回来的不是文件内容`);
      continue;
    }
    const fromName = item.name ? MIME_BY_EXT[extname(item.name).toLowerCase()] : undefined;
    const declared = typeof downloaded.data.contentType === "string" ? downloaded.data.contentType.split(";")[0]?.trim() : "";
    const mime = declared || fromName || (item.kind === "image" ? "image/png" : "application/octet-stream");
    const dataUrl = `data:${mime};base64,${Buffer.from(downloaded.data.bytes).toString("base64")}`;
    const saved = await ash.post<{ path: string }>(principal, "/api/uploads", { dataUrl, ...(item.name ? { name: item.name } : {}) });
    if (saved.ok && typeof saved.data.path === "string") out.paths.push(saved.data.path);
    else {
      out.failures.push(`${label}：${saved.ok ? "转存失败" : saved.error}`);
      if (!saved.ok && failureOf(saved) === "transient") out.transient = true;
    }
  }
  if (attachments.length > 10) out.failures.push(`一条消息最多收 10 个附件，后面 ${attachments.length - 10} 个没收`);
  return out;
}
