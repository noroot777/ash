// 附件 / 验证证据的磁盘路径 → 站内接口地址。
//
// 数据根不一定叫 `data`：mac 版落在 `~/Library/Application Support/<bundle>/`，NAVI_DATA_DIR 还能
// 指到任何地方。只认 `data/uploads/` 的那一版在 mac 版上把贴进来的图一律画成文件卡片；改认
// 「路径形状像 uploads/<id>-名」的那一版又把项目里同名的另一张图换成了旧上传图。所以本实例的
// 资源只按服务端交来的真实根认（AuthState.resourceRoots）。
import assert from "node:assert/strict";

globalThis.window = { location: { origin: "https://navi.local" } };
const { setResourceRoots } = await import("../src/lib/resourceRoots.ts");
const { attachmentView } = await import("../src/task-detail/utils.ts");
const { reviewFileTarget, imagePreviewTarget, reportFileResolver, taskFileResolver } = await import("../src/components/markdownPolicy.ts");

const MAC = "/Users/someone/Library/Application Support/dev.navi.mac";
setResourceRoots({ uploads: `${MAC}/uploads`, runs: [`${MAC}/runs`] });

// ① 本实例 uploads 目录直下的附件：认得出、给得出接口地址、是图就按图画。
assert.deepEqual(attachmentView(`${MAC}/uploads/2gCdqDs7Uawp-image.png`), { name: "image.png", url: "/api/uploads/2gCdqDs7Uawp-image.png", image: true });
assert.equal(attachmentView(`${MAC}/uploads/abcdefghijkl-notes.pdf`).image, false, "非图片照旧是文件卡片");
assert.equal(attachmentView(`${MAC}/uploads/abcdefghijkl-notes.pdf`).url, "/api/uploads/abcdefghijkl-notes.pdf", "但可以下载");
assert.equal(attachmentView(`${MAC}/uploads/sub/abcdefghijkl-x.png`).url, null, "uploads 是扁平目录，子目录里的不是附件");

// ② 不在本实例根下的绝对路径不是附件，哪怕长得一模一样：项目里复制进来改过的同名图要走任务文件。
const projectCopy = "/tmp/project/uploads/UWtGbL61OEJd-image.png";
assert.equal(attachmentView(projectCopy).url, null);
assert.match(imagePreviewTarget(projectCopy, taskFileResolver("T9"))?.url ?? "", /\/api\/tasks\/T9\/file\/raw\?path=/);
for (const project of ["/tmp/project/runs/other/review/round-1/shot.png", "/tmp/project/runs/other/free-review/R1/round-1/shot.png"]) {
  assert.equal(reviewFileTarget(project), null, `${project} 不是别的任务的证据`);
  assert.match(imagePreviewTarget(project, taskFileResolver("T9"))?.url ?? "", /\/api\/tasks\/T9\/file\/raw\?path=/);
}

// ③ 别的根下的 data/uploads、data/runs 是改认真实根之前就有的老口径，留给导入/搬家的历史消息。
assert.equal(attachmentView("/Users/someone/code/navi/data/uploads/legacy.png").url, "/api/uploads/legacy.png");
assert.equal(attachmentView("/data/uploads/a.png").url, "/api/uploads/a.png");
assert.equal(attachmentView("data/uploads/a.png").url, null, "相对路径不归数据根");
assert.match(reviewFileTarget("/Users/someone/code/navi/data/runs/T1/review/round-2/shot.png")?.url ?? "", /\/tasks\/T1\/review\/file\?round=2/);

// ④ Windows：反斜杠、大小写不敏感；UNC 的裸写法与 file URL 认法一致。
setResourceRoots({ uploads: "D:\\Navi\\uploads", runs: ["\\\\nas\\share\\navi\\runs"] });
assert.equal(attachmentView("d:\\navi\\Uploads\\abcdefghijkl-shot.jpg").url, "/api/uploads/abcdefghijkl-shot.jpg");
assert.equal(reviewFileTarget("\\\\nas\\share\\navi\\runs\\T1\\review\\round-1\\a.png")?.name, "a.png");
assert.equal(reviewFileTarget("file://nas/share/navi/runs/T1/review/round-1/a.png")?.name, "a.png");
setResourceRoots({ uploads: `${MAC}/uploads`, runs: [`${MAC}/runs`, "/srv/main/runs"] });

// ⑤ 证据：本实例 runs 根（含预览的只读回退）下解到证据接口；站外网址照旧不改写。
const evidence = reviewFileTarget(`${MAC}/runs/T1/review/round-2/shot.png`);
assert.equal(evidence?.name, "shot.png");
assert.match(evidence?.url ?? "", /\/tasks\/T1\/review\/file\?round=2/);
assert.equal(reviewFileTarget(`file://${MAC.replaceAll(" ", "%20")}/runs/T1/free-review/R1/round-3/%E5%9B%BE.png`)?.name, "图.png");
assert.equal(reviewFileTarget("/srv/main/runs/T1/review/round-1/deep/a.png")?.name, "deep/a.png");
assert.equal(reviewFileTarget("https://example.invalid/data/runs/T1/review/round-2/shot.png"), null);
assert.equal(reviewFileTarget(`${MAC}/runs/T1/review/round-2/../../../x.png`), null);

// ⑥ 已经是站内 URL 的附件地址原样用，不许当文件名再编码一遍（中文名、缓存参数、片段）。
for (const href of [
  "/api/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png",
  "/api/uploads/z4qFuU0SQTQD-image.png?v=1",
  "/api/uploads/z4qFuU0SQTQD-image.png#preview",
]) {
  assert.equal(imagePreviewTarget(href)?.url, `https://navi.local${href}`, `${href} 应原样保留`);
}
assert.equal(imagePreviewTarget("//cdn.example.invalid/x/uploads/abcdefghijkl-shot.png")?.url, undefined);
// 磁盘路径里的中文按一次解码认（与工作目录那一档同一份口径），查询/片段不是名字的一部分。
assert.equal(
  imagePreviewTarget(`${MAC}/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png?v=1`)?.url,
  "/api/uploads/3X58z1a6EpnC-%E5%9B%BE%E4%BA%8C.png",
);

// ⑦ 相对路径属于引用它的那份文档：报告里的 uploads/… 与 runs/… 都是证据目录里的文件。
const resolve = reportFileResolver((name) => `/api/tasks/T1/review/file?round=1&name=${encodeURIComponent(name)}`, "T1");
for (const relative of [
  "uploads/abcdefghijkl-shot.png",
  "data/uploads/abcdefghijkl-shot.png",
  "assets/runs/other/review/round-1/shot.png",
  "assets/runs/other/free-review/R1/round-1/shot.png",
  "data/runs/other/review/round-1/shot.png",
]) {
  assert.equal(reviewFileTarget(relative), null, `${relative} 不许被换到别的根`);
  assert.equal(imagePreviewTarget(relative, resolve)?.url, `/api/tasks/T1/review/file?round=1&name=${encodeURIComponent(relative)}`);
}

// ⑧ 还没拿到根（进不来的人）时只剩老口径，不会把任意路径猜成附件。
setResourceRoots(null);
assert.equal(attachmentView(`${MAC}/uploads/2gCdqDs7Uawp-image.png`).url, null);

console.log("attachment paths ok");
