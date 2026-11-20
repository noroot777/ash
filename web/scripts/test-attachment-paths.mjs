// 附件 / 验证证据的磁盘路径 → 站内接口地址。
//
// 数据根不一定叫 `data`：mac 版落在 `~/Library/Application Support/<bundle>/`，NAVI_DATA_DIR 还能
// 指到任何地方。只认 `data/uploads/` 的那一版在 mac 版上把贴进来的图一律画成文件卡片。
import assert from "node:assert/strict";

globalThis.window = { location: { origin: "https://navi.local" } };
const { attachmentView } = await import("../src/task-detail/utils.ts");
const { reviewFileTarget, imagePreviewTarget, reportFileResolver } = await import("../src/components/markdownPolicy.ts");

// ① mac 版数据根下的上传附件：认得出、给得出接口地址、是图就按图画。
const mac = attachmentView("/Users/someone/Library/Application Support/dev.navi.mac/uploads/2gCdqDs7Uawp-image.png");
assert.deepEqual(mac, { name: "image.png", url: "/api/uploads/2gCdqDs7Uawp-image.png", image: true });

// ② 任意数据根、Windows 反斜杠、agent 落的图同理。
assert.equal(attachmentView("/srv/navi-data/uploads/abcDEF_12-34-agent-image-1.png").url, "/api/uploads/abcDEF_12-34-agent-image-1.png");
assert.equal(attachmentView("D:\\navi\\uploads\\abcdefghijkl-shot.jpg").image, true);
assert.equal(attachmentView("/x/uploads/abcdefghijkl-notes.pdf").image, false, "非图片照旧是文件卡片");
assert.equal(attachmentView("/x/uploads/abcdefghijkl-notes.pdf").url, "/api/uploads/abcdefghijkl-notes.pdf", "但可以下载");

// ③ 仓库检出的 data/uploads 照旧认，连没有 id 前缀的老附件一起。
assert.equal(attachmentView("/Users/someone/code/navi/data/uploads/legacy.png").url, "/api/uploads/legacy.png");

// ④ 用户项目里碰巧叫 uploads 的目录不是附件：没有 id 前缀的、隔了一层子目录的都不认。
assert.equal(attachmentView("/Users/someone/site/public/uploads/logo.png").url, null);
assert.equal(attachmentView("/Users/someone/site/uploads/abcdefghijkl/x.png").url, null);
assert.equal(attachmentView("/Users/someone/site/src/abcdefghijkl-x.png").url, null);

// ⑤ 验证证据同理：数据根不叫 data 也解到证据接口；站外网址照旧不改写。
const evidence = reviewFileTarget("/Users/someone/Library/Application Support/dev.navi.mac/runs/T1/review/round-2/shot.png");
assert.equal(evidence?.name, "shot.png");
assert.match(evidence?.url ?? "", /\/tasks\/T1\/review\/file\?round=2/);
const freeEvidence = reviewFileTarget("file:///Users/someone/Library/Application Support/dev.navi.mac/runs/T1/free-review/R1/round-3/a.png");
assert.equal(freeEvidence?.name, "a.png");
assert.equal(reviewFileTarget("https://example.invalid/runs/T1/review/round-2/shot.png"), null);

// ⑥ 已经是站内 URL 的附件地址原样用，不许当文件名再编码一遍（中文名、缓存参数、片段）。
for (const href of [
  "/api/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png",
  "/api/uploads/z4qFuU0SQTQD-image.png?v=1",
  "/api/uploads/z4qFuU0SQTQD-image.png#preview",
]) {
  assert.equal(imagePreviewTarget(href)?.url, `https://navi.local${href}`, `${href} 应原样保留`);
}
assert.equal(imagePreviewTarget("/api/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png")?.name, "3X58z1a6EpnC-图二.png");
assert.equal(attachmentView("/api/uploads/z4qFuU0SQTQD-image.png").url, null, "站内地址不是磁盘路径");
// 协议相对网址是别人站上的图，不换成本机附件。
assert.equal(imagePreviewTarget("//cdn.example.invalid/x/uploads/abcdefghijkl-shot.png")?.url, undefined);
// 磁盘路径里的中文按一次解码认（与工作目录那一档同一份口径），查询/片段不是名字的一部分。
assert.equal(
  imagePreviewTarget("/Users/someone/Library/Application Support/dev.navi.mac/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png?v=1")?.url,
  "/api/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png",
);

// ⑦ 相对路径属于引用它的那份文档：报告里的 uploads/… 与 assets/runs/… 都是证据目录里的文件。
const resolve = reportFileResolver((name) => `/api/tasks/T1/review/file?round=1&name=${encodeURIComponent(name)}`, "T1");
assert.equal(
  imagePreviewTarget("uploads/abcdefghijkl-shot.png", resolve)?.url,
  "/api/tasks/T1/review/file?round=1&name=uploads%2Fabcdefghijkl-shot.png",
);
assert.equal(attachmentView("uploads/abcdefghijkl-shot.png").url, null);
for (const relative of [
  "assets/runs/other/review/round-1/shot.png",
  "assets/runs/other/free-review/R1/round-1/shot.png",
  "runs/other/review/round-1/shot.png",
]) {
  assert.equal(reviewFileTarget(relative), null, `${relative} 不许被换到别的任务的证据接口`);
  assert.equal(
    imagePreviewTarget(relative, resolve)?.url,
    `/api/tasks/T1/review/file?round=1&name=${encodeURIComponent(relative)}`,
  );
}

console.log("attachment paths ok");
