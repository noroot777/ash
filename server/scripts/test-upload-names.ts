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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const { MAX_STORED_NAME_BYTES, isSafeUploadName, newUploadName, resolveUploadRun, sanitizeUploadName, sanitizeUploadStem, uploadNameIndex } = await import("../src/upload-names.js");
const { collectUploads, scanUploadNames, scanUploadRuns, writeUploads } = await import("../src/handoff-uploads.js");
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
  const long = newUploadName(sanitizeUploadName("汉".repeat(200) + ".pdf"));
  assert.ok(Buffer.byteLength(long) <= 255, `落盘名必须在 255 字节内,实际 ${Buffer.byteLength(long)}`);
  assert.ok(long.endsWith(".pdf"), "截断保末尾 —— 扩展名决定 Content-Type,丢不得");
  writeFileSync(join(uploads, long), "x");

  // ── 生成端的输出,校验端必须收得下 —— 而且叠多少次都收得下 ─────────────────
  // 审查第 1 轮发现 1:撞名改名曾写成 `${id()}-${原名}`,191 字节的长中文名改一次名
  // 变 204 字节,下一跳把**自己生成的名字**判成非法跳过,附件在那台机器上直接消失。
  let chained = long;
  for (let round = 0; round < 6; round += 1) {
    chained = newUploadName(chained);
    assert.ok(Buffer.byteLength(chained) <= MAX_STORED_NAME_BYTES,
      `第 ${round + 1} 次改名把名字撑大了(${Buffer.byteLength(chained)} 字节),改名必须是重新生成而不是叠前缀`);
    assert.ok(isSafeUploadName(chained), "生成端的输出,校验端必须收得下");
    assert.ok(chained.endsWith(".pdf"), "改名也要保住扩展名");
  }

  // ── agent 落图的主干名:同一份字符集,扩展名由 mime 另行强制 ───────────────
  assert.equal(sanitizeUploadStem("wake-input-desktop.png"), "wake-input-desktop", "老行为不变");
  assert.equal(sanitizeUploadStem("截图 2026-10-31.png"), "截图-2026-10-31", "中文主干留住");
  assert.equal(sanitizeUploadStem("/tmp/a/b/图.PNG"), "图");

  // ── 校验端:远端送来的名字 ────────────────────────────────────────────────
  assert.ok(isSafeUploadName("abc-第九期实战作业.pdf"));
  assert.ok(isSafeUploadName("n".repeat(249)),
    "旧版本叠前缀能写出 249 字节的名字,本机既然存着它,接力就得收得下(审查第 2 轮 N2)");
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

  // ── 撞名落地 → 再接力一跳:改名产出的名字必须还能被下一跳收下 ───────────────
  // (这条在旧写法下会红:firstNameBytes=204 > 上限,secondCount=0)
  const collided = { name: long, sourcePath: join(uploads, long), dataBase64: Buffer.from("别的内容").toString("base64") };
  const hop1Notes: string[] = [];
  const hop1 = await writeUploads([collided], hop1Notes);
  assert.equal(hop1.length, 1, "撞上本机同名文件要改名落地,不是丢掉");
  assert.notEqual(hop1[0]!.name, long, "本机原文件不许被远端内容顶掉");
  assert.ok(existsSync(join(uploads, hop1[0]!.name)));
  assert.ok(Buffer.byteLength(hop1[0]!.name) <= MAX_STORED_NAME_BYTES,
    `改名产出 ${Buffer.byteLength(hop1[0]!.name)} 字节,超出生成端上限(旧写法 ${13 + Buffer.byteLength(long)} 字节就是这么漏附件的)`);
  const hop2Notes: string[] = [];
  const hop2 = await writeUploads([{ ...collided, name: hop1[0]!.name }], hop2Notes);
  assert.deepEqual(hop2Notes.filter((n) => n.includes("非法")), [], `下一跳不该把自己生成的名字判非法:${hop2Notes}`);
  assert.equal(hop2.length, 1, "长中文名附件再接力一跳不能凭空消失");

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

  // ── 路径后面紧跟中文说明:按本机真有的名字收敛,文本启发式一概不用 ─────────
  // 审查第 1 轮发现 2 / 第 2 轮发现 1:只按字符集切会把后文吞进名字;改按「最后一处
  // 扩展名」再猜一刀,后文里出现 `v1.2` 又猜偏。正文/续跑说明里直接粘路径是正常入口,
  // 没有附件块兜底,这两种写法都必须找回真文件。
  const ascii = "aBcD1234_-xy-report.pdf";
  writeFileSync(join(uploads, ascii), "pdf");
  const index = uploadNameIndex(readdirSync(uploads));
  for (const tail of ["的要求完成作业", "的要求按v1.2版本完成作业", "的第2.1节", "。"]) {
    const glued = `请按 ${join(uploads, ascii)}${tail}`;
    const resolved = scanUploadRuns(glued).map((run) => resolveUploadRun(run, index));
    assert.deepEqual(resolved, [ascii], `后缀「${tail}」没能收敛回真名字:${resolved}`);
    const noteBuf: string[] = [];
    const packed = await collectUploads([glued], noteBuf, true, async () => true);
    assert.deepEqual(packed.map((u) => u.name), [ascii], `后缀「${tail}」下附件没被打包`);
    assert.deepEqual(noteBuf, [], `不该多报一句:${noteBuf}`);
  }
  // 反向:结尾没有扩展名、内部有点号的合法名字 —— 按扩展名猜那一刀会把它截成 v1.2。
  const dotted = "aBcD1234_-xy-v1.2终稿";
  writeFileSync(join(uploads, dotted), "x");
  const dottedIndex = uploadNameIndex(readdirSync(uploads));
  assert.equal(resolveUploadRun(dotted, dottedIndex), dotted, "整段本身就是真名字时不许被截短");
  assert.equal(resolveUploadRun(`${dotted}的说明`, dottedIndex), dotted, "它后面粘上中文同样要收敛回来");

  // 对不上本机任何名字时原样返回,notes 报的是**原文那一段**而不是收敛后的名字 ——
  // 「有这个文件但你读不到」和「本机压根没有」必须是同一句话、同样的条数(存在性探针)。
  const ghostNotes: string[] = [];
  const ghost = `${join(uploads, "nOtHeRe12345-x.pdf")}的要求`;
  assert.deepEqual(await collectUploads([ghost], ghostNotes, true, async () => true), []);
  assert.equal(ghostNotes.length, 1, "一处引用恒一条交代");
  assert.ok(ghostNotes[0]!.includes("nOtHeRe12345-x.pdf的要求"), `notes 要报原文那一段:${ghostNotes[0]}`);
  // 同一份文本里两处指向同一个**读不到**的文件:条数只跟文本有关,不随它存不存在变化。
  const probeNotes: string[] = [];
  await collectUploads([`${join(uploads, ascii)}的 和 ${join(uploads, ascii)}的要求`], probeNotes, true, async () => false);
  assert.equal(probeNotes.length, 2, "两处引用两条交代 —— 条数随存在性变化就是一个存在性探针");

  // 成本:收敛是「每处引用一个有界常数」,不是全局两两比较(审查第 2 轮发现 2:
  // 旧写法 80k 条引用把主服务同步卡住 16.8 秒)。阈值放得很松,只拦平方级回归。
  const bulk = Array.from({ length: 20_000 }, (_, i) => `${join(uploads, `bulk${String(i).padStart(8, "0")}-x.pdf`)} `).join("");
  const started = Date.now();
  await collectUploads([bulk], [], true, async () => false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `2 万条引用的盘点耗时 ${elapsed}ms —— 这段在第一次 await 之前跑,会卡住同进程其它请求`);

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
