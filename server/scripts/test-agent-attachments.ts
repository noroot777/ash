import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  destinationFilePath,
  hasUrlScheme,
  isNetworkDestination,
  markdownImageRefs,
} from "@ash/shared/markdown-images";
import {
  imageStore,
  persistMarkdownImages,
  persistToolResultImages,
  type ImageStore,
} from "../src/agent-attachments.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const GENERATED_BASE64 = Buffer.concat([
  Buffer.from(PNG_BASE64, "base64"),
  Buffer.alloc(64),
]).toString("base64");
const root = mkdtempSync(join(tmpdir(), "ash-agent-attachments-"));
const uploads = join(root, "data", "uploads");
const localImage = join(root, "local screenshot.png");

try {
  writeFileSync(localImage, Buffer.from(PNG_BASE64, "base64"));

  const mcp = persistToolResultImages({
    content: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
  }, imageStore(), { directory: uploads });
  assert.equal(mcp.length, 1);
  assert.deepEqual(readFileSync(mcp[0]!), Buffer.from(PNG_BASE64, "base64"));

  const claude = persistToolResultImages({
    content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
    }],
  }, imageStore(), { directory: uploads });
  assert.equal(claude.length, 1);

  const generated = persistToolResultImages(GENERATED_BASE64, imageStore(), {
    allowBareBase64: true,
    directory: uploads,
  });
  assert.equal(generated.length, 1);
  const generatedDataUrl = persistToolResultImages({
    image_url: `data:image/png;base64,${PNG_BASE64}`,
  }, imageStore(), { allowBareBase64: true, directory: uploads });
  assert.equal(generatedDataUrl.length, 1);

  const seen: ImageStore = imageStore();
  const markdown = persistMarkdownImages(
    `截图：![CLI](<${localImage}>)`,
    seen,
    { directory: uploads },
  );
  assert.equal(markdown.length, 1);
  // 源文件的名字要留住:对话里那张卡片写的就是它(web attachmentView 剥掉 12 位前缀)。
  assert.match(basename(markdown[0]!.path), /^[A-Za-z0-9_-]{12}-local-screenshot\.png$/);
  // `source` 恒为**目的地原文**(剥掉 <>):展示端按它把这一句引用对回这份拷贝。文件名
  // 不能当身份 —— 它会被改扩展名、被截到 60 字、还可能撞上另一张图(审查第 1 轮 F1)。
  assert.equal(markdown[0]!.source, localImage);

  // 同一张图再被引用一次:仍要报出来(指向同一份拷贝),否则那一句配不上附件、一个字都不画。
  // `ref` 必须是**新的**身份:字节可以内容寻址去重,引用关联不能(审查第 1 轮 F1)。
  const again = persistMarkdownImages(`![重复](<${localImage}>)`, seen, { directory: uploads });
  assert.deepEqual(again, [{ path: markdown[0]!.path, source: localImage, ref: markdown[0]!.ref + 1 }]);
  assert.equal(persistMarkdownImages("![远程](https://example.com/image.png)", seen, { directory: uploads }).length, 0);

  // 相对路径按工作目录解析 —— agent 站在工作目录里写 `![](output/x.png)` 是最自然的
  // 写法,不认它那张图在对话里就只剩一个裂开的图标。
  mkdirSync(join(root, "output"), { recursive: true });
  const nested = join(root, "output", "shot.png");
  writeFileSync(nested, Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(8)]));
  const relative = persistMarkdownImages("![预览](output/shot.png)", seen, { directory: uploads, cwd: root });
  assert.equal(relative.length, 1);
  assert.match(basename(relative[0]!.path), /^[A-Za-z0-9_-]{12}-shot\.png$/);
  assert.equal(relative[0]!.source, "output/shot.png");
  // 没有 cwd 就只认绝对路径(老行为),别拿相对路径去撞 server 自己的 cwd。
  assert.equal(persistMarkdownImages("![预览](output/shot.png)", imageStore(), { directory: uploads }).length, 0);
  // 远程/内联 URL 不许被当成相对路径跟工作目录拼。
  assert.equal(
    persistMarkdownImages("![远程](https://example.com/image.png)", imageStore(), { directory: uploads, cwd: root }).length,
    0,
  );

  // ── 查询/片段不是文件名的一部分(审查第 4 轮 R4)──────────────────────────────
  // `?v=1` / `#view` 是 agent 顺手加的缓存串和锚点。展示端一直先切掉它再去工作目录取,
  // 所以**当时看得见**;保存端把整串当文件名,`extname` 得到 `.png?v=1` 一类不在类型表里
  // 的后缀,于是压根不读文件、也不留副本 —— 原文件一清理这张图就永久没了,而那条结果既
  // 没有 path 也没有 lost,事后连「没存成」都看不出来。两端共用 destinationFilePath 之后
  // 这里必须出现 path(所以也顺带钉住:不能靠扩大后缀表,那是把分隔符认成文件名)。
  for (const suffix of ["?v=1", "#view", "?v=1#view"]) {
    const query = persistMarkdownImages(`![预览](output/shot.png${suffix})`, seen, { directory: uploads, cwd: root });
    assert.equal(query.length, 1, `${suffix}:仍要报一条`);
    assert.ok(query[0]!.path, `${suffix}:真有这个文件,就必须留下副本`);
    // 存下来的名字是**文件**的名字,查询串不许跟着进文件名。
    assert.match(basename(query[0]!.path!), /^[A-Za-z0-9_-]{12}-shot\.png$/);
    // `source` 恒为目的地原文:展示端按它把正文那一句对回这份拷贝,切过的那一版配不上。
    assert.equal(query[0]!.source, `output/shot.png${suffix}`);
  }
  // 绝对路径与 `file:` 两档同样认 —— `file:` 的 pathname 本来就不含查询,这条是防回归。
  assert.ok(
    persistMarkdownImages(`![绝对](${nested}?v=9)`, seen, { directory: uploads, cwd: root })[0]?.path,
    "POSIX 绝对路径带查询串时同样要留副本",
  );
  assert.ok(
    persistMarkdownImages(`![协议](${pathToFileURL(nested).href}?v=9)`, seen, { directory: uploads })[0]?.path,
    "file: 分支本来就由 URL 解析去掉查询,不许跟着改坏",
  );
  // 先切后解码,顺序不能反:`%3F`/`%23` 是文件名里真的那个字符,先解码就会被当成分隔符
  // 切掉(这台机器上造不出带 `?` 的文件名 —— NTFS 不收,所以按字符串钉契约)。
  assert.equal(destinationFilePath("out/q%3Fb.png"), "out/q?b.png");
  assert.equal(destinationFilePath("out/q%23b.png"), "out/q#b.png");
  assert.equal(destinationFilePath("out/a b.png?v=1#x"), "out/a b.png");
  assert.equal(destinationFilePath("out/%E4%B8%80.png"), "out/一.png");
  // 解不开的转义原样留着:合不合法、爬没爬出根由读取端的门禁判,不在这一层(与 web 的
  // decodeSafe 同口径 —— 两端差一条就又是一处「一边看得见、一边不存」)。
  assert.equal(destinationFilePath("out/%ZZ.png"), "out/%ZZ.png");

  // ── 同一个路径被重拍过:两次引用各自那一份字节 ───────────────────────────────
  // 这是「结论说修改后、画出来是修改前」的来源(审查第 1 轮 F1 实例 1)。按内容定身份、
  // 逐处引用各报一条,重拍才分得开 —— 按文件名或出场顺序猜一定猜错。
  writeFileSync(nested, Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(32)]));
  const retake = persistMarkdownImages("![改完了](output/shot.png)", seen, { directory: uploads, cwd: root });
  assert.equal(retake.length, 1);
  assert.equal(retake[0]!.source, "output/shot.png");
  assert.notEqual(retake[0]!.path, relative[0]!.path, "重拍过的那张必须另存一份,不能复用上一次的");

  // ── 同一份字节、两个名字:两条都要报(path 相同、source 不同)──────────────────
  // 漏掉第二条的后果是正文那一句配不上任何附件,于是什么都不画(F1 实例 3、4)。
  const aliasA = join(root, "output", "same-a.png");
  const aliasB = join(root, "output", "same-b.png");
  writeFileSync(aliasA, Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(3)]));
  writeFileSync(aliasB, readFileSync(aliasA));
  const alias = persistMarkdownImages(
    "![甲](output/same-a.png)\n\n![乙](output/same-b.png)",
    seen,
    { directory: uploads, cwd: root },
  );
  assert.equal(alias.length, 2);
  assert.equal(alias[0]!.path, alias[1]!.path, "同一份字节只存一份拷贝");
  assert.deepEqual(alias.map((image) => image.source), ["output/same-a.png", "output/same-b.png"]);

  // ── 代码块里的路径不是图 ───────────────────────────────────────────────────
  // 服务端跟展示端共用同一个扫描器,所以这里认不认直接决定那边会不会把附件卡片吃掉
  // (审查第 1 轮 F2:写法示例把卡片领走,结果两边都什么都不画)。
  assert.equal(
    persistMarkdownImages("```md\n![示例](output/shot.png)\n```", imageStore(), { directory: uploads, cwd: root }).length,
    0,
    "围栏代码块里的写法示例不是图",
  );
  assert.equal(
    persistMarkdownImages("行内 `![示例](output/shot.png)` 不算", imageStore(), { directory: uploads, cwd: root }).length,
    0,
    "行内代码里的写法示例不是图",
  );
  // 括号里换行是合法写法,逐行扫描看不见它(所以 generic 那条链改成了攒一段再扫)。
  assert.equal(
    persistMarkdownImages("![跨行](\noutput/shot.png\n)", imageStore(), { directory: uploads, cwd: root }).length,
    1,
    "括号内换行仍是同一条引用",
  );

  // ── 目的地扫描:<> 要剥掉,起止要指到目的地本身(展示端按它原地改写)──────────
  const titled = '![a](<out/一 二.png> "标题")';
  const refs = markdownImageRefs(titled);
  assert.deepEqual(refs.map((ref) => ref.destination), ["out/一 二.png"]);
  // 起止指到**整处引用**,改写时整段换掉(见 shared 的 rewriter:只换目的地就得先找到 alt
  // 的收尾方括号,而 alt 里可以有成对/转义的方括号,还可能压根是引用式写法)。
  assert.equal(titled.slice(refs[0]!.start, refs[0]!.end), titled);
  assert.equal(refs[0]!.rewrite("/api/uploads/x.png"), "![a](/api/uploads/x.png)");

  // ── Windows 盘符不是 URL 协议(审查第 1 轮 F4,正是上一版引入的回归)───────────
  // 这一条在 macOS 上也验得了:协议判据与平台无关。盘符绝对路径在 Windows 上由
  // `isAbsolute` 走另一条分支,这里用一个真叫 `D:` 的目录证明它**不再被当成站外地址扔掉**。
  assert.equal(hasUrlScheme("D:\\work\\shot.png"), false);
  assert.equal(hasUrlScheme("d:/work/shot.png"), false);
  assert.equal(hasUrlScheme("file:///tmp/shot.png"), true);
  assert.equal(hasUrlScheme("https://example.com/a.png"), true);
  assert.equal(hasUrlScheme("data:image/png;base64,AAAA"), true);
  // 不造 `D:` 这个目录:NTFS 上 `join(root, "D:", "work")` 是非法名字,那条路在 Windows
  // 真机上 ENOENT(审查第 2 轮 N2)。改用**保存结果**来证明:盘符路径被当成本机路径走到了
  // 读文件那一步(于是报「这处引用没有副本」),而不是在协议判据那儿就被扔掉(一条都不报)。
  const drive = persistMarkdownImages("![盘符](D:/work/win.png)", imageStore(), { directory: uploads, cwd: root });
  assert.deepEqual(
    drive.map((image) => image.source),
    ["D:/work/win.png"],
    "`D:` 被当成协议时这一条恒为空 —— 那就是 Windows 上图全没了的那个回归",
  );
  assert.equal(drive[0]!.path, undefined, "文件不在就明确报「这处引用没有副本」");

  // ── 协议相对网址是站外地址,不是本机路径(审查第 2 轮 F3)──────────────────────
  // `//cdn.example.invalid/a.png` 没有协议,却绝不是本机文件。只问 scheme 的那一版把它交给
  // `isAbsolute`(/ 开头 → 真)去读 `/cdn.example.invalid/a.png`,必然失败,还白报一条
  // 「这处引用没有副本」—— 于是展示端把这张站外图改写成「去工作目录取」,永远画不出来。
  // 判据跟 Windows UNC(`\\server\share`,反斜杠)不重叠,上面那条盘符用例一起钉住。
  assert.equal(isNetworkDestination("//cdn.example.invalid/a.png"), true);
  assert.equal(isNetworkDestination("https://example.com/a.png"), true);
  assert.equal(isNetworkDestination("D:/work/shot.png"), false);
  assert.equal(isNetworkDestination("\\\\server\\share\\shot.png"), false);
  assert.deepEqual(
    persistMarkdownImages("![远程](//cdn.example.invalid/a.png)", imageStore(), { directory: uploads, cwd: root }),
    [],
    "协议相对网址一条都不报 —— 报了就等于告诉展示端「这处引用我管过」",
  );

  // ── 落盘失败不许毒化本轮重试,也不许把事件流带走 ─────────────────────────────
  const blocked = join(root, "not-a-dir");
  writeFileSync(blocked, "x");
  const retryStore: ImageStore = imageStore();
  assert.deepEqual(
    persistMarkdownImages(`![失败](<${localImage}>)`, retryStore, { directory: blocked }),
    [{ source: localImage, ref: 0, lost: true }],
    "写不进去要如实报(不抛:抛出去会变成没人监听的 uncaughtException),而且得报成 lost ——"
      + "**字节读到了、存不下来**和「压根没有这个文件」是两件事:前者那一刻的画面已经丢了,"
      + "展示端必须作废那一处(现在去读文件拿到的是后来的画面);后者文件可能还好好躺在工作"
      + "目录里,去取一次是对的(审查第 3 轮 R1)",
  );
  assert.equal(retryStore.copies.size, 0, "没真落盘就不能记进 seen,否则恢复可写后本轮再也不重试");
  assert.equal(persistMarkdownImages(`![重试](<${localImage}>)`, retryStore, { directory: uploads }).length, 1);

  console.log("Agent 图片附件持久化验证通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}
