import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { maxBytesFor, attachmentKind } from "@ash/shared";
import { UPLOADS_DIR } from "./paths.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { canReadUpload, registerUpload } from "./uploads.js";
import { id } from "./util.js";

// ── attachment uploads (pasted into the composer / reply box) ────────────────
// Agents take text on stdin, not binaries — so we persist the pasted image/file
// and hand its absolute path to the agent (it reads it with the Read tool). See
// attachmentsPrompt. ANY type is accepted; size caps mirror Claude Code / Codex
// (vision images ≤5MB, any other file ≤20MB — maxBytesFor).
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
};
const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Keep stored filenames to a single safe path segment and bounded length.
const sanitizeName = (name: string): string =>
  (name || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "").slice(-80);

export function mountUploadRoutes(api: Hono): void {
  // Accept a base64 data URL of any type, persist it, return the absolute path (for
  // the prompt) plus a url (preview thumbnail) and the kind (image vs file → which
  // chip the web shows). The agent-facing filename keeps the original name when the
  // client sent one, prefixed with an id so concurrent pastes never collide.
  api.post("/uploads", async (c) => {
    const { dataUrl, name } = await c.req.json<{ dataUrl?: string; name?: string }>();
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl ?? "");
    if (!m) return c.json({ error: "需要 data:<mime>;base64 格式的数据" }, 400);
    const mime = m[1];
    const bytes = Buffer.from(m[2], "base64");
    const cap = maxBytesFor(mime);
    if (bytes.length > cap) {
      return c.json(
        { error: `文件过大：${(bytes.length / 1048576).toFixed(1)}MB，上限 ${Math.round(cap / 1048576)}MB`, max: cap },
        413,
      );
    }
    const display = sanitizeName(name ?? "") || `pasted.${MIME_EXT[mime] ?? "bin"}`;
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const file = `${id()}-${display}`;
    writeFileSync(join(UPLOADS_DIR, file), bytes);
    // 谁上传的就归谁(§八)。目录是扁平的、文件名就是全部信息,不登记这一句的话
    // 「谁能读它」在多人模式下无从判起 —— 判据见 uploads.ts。
    await registerUpload(file, { ownerUserId: ownerIdOf(actorOf(c)) });
    return c.json({
      id: file,
      path: join(UPLOADS_DIR, file),
      url: `/api/uploads/${file}`,
      name: display,
      kind: attachmentKind(mime),
    });
  });

  // Serve a stored attachment back (thumbnail preview). basename() strips any path
  // so `..` can't escape UPLOADS_DIR. Non-previewable types fall back to octet-stream.
  //
  // 授权走 canReadUpload(uploads.ts):附件是**内容的一部分**,私有随手记的附件不能
  // 因为躺在同一个扁平目录里就人人可读(第 3 轮审查 P1)。这道判据没有登记进
  // resource-gate 的 PROJECT_OF —— 那张表回答的是「这个 id 属于哪个项目」,而附件有
  // 一半(随手记的、刚传上来还没挂任务的)压根不属于任何项目,拆成两处就会有两个答案。
  // 没权限与不存在**回同一句 404**:否则挨个文件名试一遍就能问出「这个文件存在」。
  api.get("/uploads/:file", async (c) => {
    const file = basename(c.req.param("file"));
    if (!(await canReadUpload(actorOf(c), file))) return c.json({ error: "not found" }, 404);
    try {
      const body = await readFile(join(UPLOADS_DIR, file));
      return c.body(body, 200, { "content-type": EXT_MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
    } catch {
      return c.json({ error: "not found" }, 404);
    }
  });
}
