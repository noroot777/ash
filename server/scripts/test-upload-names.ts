// 附件文件名的字符集契约(`server/src/upload-names.ts`)。
//
// 起因:2026-10-31 用户报「中文附件名复制到任务后就没了」——「第九期实战作业.pdf」落盘
// 成 `<id>-pdf`、「附件1 案例模版.docx」成 `<id>-1_.docx`,界面上那排附件只剩扩展名,
// 根本分不出哪个是哪个。根因是上传接口的净化把非 ASCII 一律换 `_` 之后又整段剥掉前导
// `_`;而 agent 落图那一份净化早就放行了汉字,扫描端却只认 ASCII,两套字符集互相打架。
//
// 这条用例钉的是**三端共用同一份字符集**:生成(上传/落图)、校验(接力落地)、扫描
// (正文里认出附件路径)。
//
// 跑法(自带临时库):
//   npm -w server run test:upload-names
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-upload-names-"));
const uploads = join(root, "uploads");
process.env.ASH_DB ||= join(root, "upload-names.db");
process.env.ASH_UPLOADS_DIR = uploads;
requireTmpDb("test-upload-names");
mkdirSync(uploads, { recursive: true });

// 碰库的模块一律 await import:静态 import 会被提升到设 ASH_DB 之前,那样连的是真库。
const { isSafeUploadName, sanitizeUploadName, sanitizeUploadStem } = await import("../src/upload-names.js");
const { scanUploadNames, writeUploads } = await import("../src/handoff-uploads.js");
const { uploadNameOf } = await import("../src/uploads.js");
const { attachmentsPrompt } = await import("../src/util.js");
const { ensureSchema } = await import("../src/db/index.js");
const { Hono } = await import("hono");
const { mountUploadRoutes } = await import("../src/upload-routes.js");

await ensureSchema();
const app = new Hono();
mountUploadRoutes(app);

/** 展示端(web `attachmentView`)剥 id 前缀的那一刀,逐字照抄过来。 */
const displayed = (file: string): string => file.replace(/^[A-Za-z0-9_-]{12}-/, "") || file;
const ID = "aBcD1234_-xy";

try {
  // ── 生成端:原名能留多少留多少 ────────────────────────────────────────────
  assert.equal(sanitizeUploadName("第九期实战作业.pdf"), "第九期实战作业.pdf", "汉字是合法文件名字符,不许换成 _");
  assert.equal(displayed(`${ID}-${sanitizeUploadName("第九期实战作业.pdf")}`), "第九期实战作业.pdf",
    "界面上写的就是用户看到的那个名字 —— 这正是用户报的那一幕(当时只剩 `pdf`)");
  assert.equal(sanitizeUploadName("附件1 案例模版.docx"), "附件1_案例模版.docx",
    "空格换 `_`:它既是 shell/日志里的分隔符,也是扫描端的边界之一;汉字照留");
  assert.equal(sanitizeUploadName("课件： 情境领导力.pdf"), "课件_情境领导力.pdf", "连续的集合外字符压成一个 _");
  assert.equal(sanitizeUploadName("résumé.pdf"), "résumé.pdf", "带变音符号的拉丁字母同样是 \\p{L}");
  assert.equal(sanitizeUploadName("файл.txt"), "файл.txt", "不是只给中文开的口子");
  assert.equal(sanitizeUploadName("report.tar.gz"), "report.tar.gz", "纯 ASCII 名字逐字不变(老行为)");

  // ── 生成端:单路径段的安全性一条都不许松 ──────────────────────────────────
  assert.equal(sanitizeUploadName("../../etc/passwd"), "passwd", "目录成分只取末段");
  assert.equal(sanitizeUploadName("C:\\Users\\x\\作业.pdf"), "作业.pdf", "反斜杠同样是分隔符(Windows 客户端报整条路径)");
  assert.equal(sanitizeUploadName(".."), "", "`..` 净化成空,由调用方退到 pasted.<ext>");
  assert.equal(sanitizeUploadName(".hidden"), "hidden", "前导点剥掉,不生成隐藏文件");
  assert.equal(sanitizeUploadName("a\u0000b\u202Ec.png"), "a_b_c.png", "控制字符与双向改写字符都在集合外");

  // 长度两头都要卡住:80 个汉字 = 240 字节,只卡码点数会把文件名顶过 APFS/ext4 的 255 字节墙。
  const long = `${ID}-${sanitizeUploadName("汉".repeat(200) + ".pdf")}`;
  assert.ok(Buffer.byteLength(long) <= 255, `落盘名必须在 255 字节内,实际 ${Buffer.byteLength(long)}`);
  assert.ok(long.endsWith(".pdf"), "截断保末尾 —— 扩展名决定 Content-Type,丢不得");
  writeFileSync(join(uploads, long), "x");

  // ── agent 落图的主干名:同一份字符集,扩展名由 mime 另行强制 ───────────────
  assert.equal(sanitizeUploadStem("wake-input-desktop.png"), "wake-input-desktop", "老行为不变");
  assert.equal(sanitizeUploadStem("截图 2026-10-31.png"), "截图-2026-10-31", "中文主干留住");
  assert.equal(sanitizeUploadStem("/tmp/a/b/图.PNG"), "图");

  // ── 校验端:远端送来的名字 ────────────────────────────────────────────────
  assert.ok(isSafeUploadName("abc-第九期实战作业.pdf"));
  for (const bad of ["a/b", "a\\b", ".", "..", "x\u0000y", "x\u202Ey", "n".repeat(300)]) {
    assert.equal(isSafeUploadName(bad), false, `这个名字不该放行:${JSON.stringify(bad)}`);
  }

  const notes: string[] = [];
  const written = await writeUploads([
    { name: "zzzz1111aaaa-第九期实战作业.pdf", sourcePath: "/src/第九期实战作业.pdf", dataBase64: Buffer.from("pdf").toString("base64") },
    { name: "../escape.txt", sourcePath: "/src/escape.txt", dataBase64: Buffer.from("no").toString("base64") },
  ], notes);
  assert.deepEqual(written.map((u) => u.name), ["zzzz1111aaaa-第九期实战作业.pdf"],
    "中文名的接力附件要能落地,带目录成分的照旧拒收");
  assert.equal(notes.length, 1);

  // ── 扫描端:正文里认得出中文名的附件路径 ──────────────────────────────────
  const file = "zzzz1111aaaa-第九期实战作业.pdf";
  const abs = join(uploads, file);
  const body = `帮我完成这个作业${attachmentsPrompt([abs, join(uploads, "qqqq2222bbbb-附件1_案例模版.docx")])}`;
  assert.deepEqual([...scanUploadNames(body)].sort(), [file, "qqqq2222bbbb-附件1_案例模版.docx"].sort(),
    "附件块每行一条路径,行尾就是边界");
  assert.deepEqual([...scanUploadNames(JSON.stringify({ text: `看了 ${abs} 之后` }))], [file],
    "JSON 字符串里路径两侧是引号/空格,都在集合外");
  assert.deepEqual([...scanUploadNames(`![图](${abs})`)], [file], "markdown 的 `)` 同样收口");
  assert.deepEqual([...scanUploadNames(`我读了 ${abs},有三点`)], [file], "中文标点也在集合外");

  // 归属回填/任务绑定认的是同一条路径:认不出来 = 多人模式下这张附件对项目成员恒 404。
  assert.equal(uploadNameOf(abs), file, "带路径的要能归一到文件名");
  assert.equal(uploadNameOf(file), file, "裸文件名(接力载荷的形态)照认");
  assert.equal(uploadNameOf("/etc/passwd"), null, "uploads 目录之外的一律不认");

  // ── 真走一遍上传接口:用户报的那一幕就发生在这条路上 ──────────────────────
  const posted = await app.request("/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: `data:application/pdf;base64,${Buffer.from("%PDF-1.4").toString("base64")}`, name: "第九期实战作业.pdf" }),
  });
  assert.equal(posted.status, 200);
  const saved = await posted.json() as { id: string; path: string; name: string; url: string };
  assert.equal(saved.name, "第九期实战作业.pdf", "接口回给前端的名字就是用户那个名字");
  assert.ok(saved.id.endsWith("-第九期实战作业.pdf"), `落盘名丢了原名:${saved.id}`);
  assert.ok(existsSync(saved.path), "盘上得真有这个文件(名字含中文不该把写盘搞挂)");
  assert.equal(displayed(saved.id), "第九期实战作业.pdf", "界面上那张卡片写的就是它");
  // agent 拿到的是绝对路径,它必须能从自己的 prompt 文本里被重新扫出来(归属回填/接力都靠这个)。
  assert.deepEqual([...scanUploadNames(attachmentsPrompt([saved.path]))], [saved.id]);

  // 读回来:URL 段要 percent-encode,下载名用的是剥掉 id 前缀的原名。
  assert.equal(saved.url, `/api/uploads/${encodeURIComponent(saved.id)}`, "URL 段必须转义");
  const fetched = await app.request(saved.url.replace("/api", ""));
  assert.equal(fetched.status, 200, "带中文的附件要能原样读回来");
  assert.equal(fetched.headers.get("content-type"), "application/pdf");
  assert.equal(
    fetched.headers.get("content-disposition"),
    `inline; filename*=UTF-8''${encodeURIComponent("第九期实战作业.pdf")}`,
    "另存为时给的是用户那个名字,而不是带 id 前缀的落盘名",
  );
  assert.equal(await fetched.text(), "%PDF-1.4");

  console.log("附件文件名字符集契约验证通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
