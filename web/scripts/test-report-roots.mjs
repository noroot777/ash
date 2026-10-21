// 报告正文里一处相对路径说的是**证据目录里那一份**，还是**被审任务工作目录里那一份**。
//
// 判据只有一条，而且是 Markdown/HTML 的通用口径：**相对路径相对的就是这份文档自己那个
// 目录**。解不成相对路径的那些（绝对路径、`file:`、UNC、盘符）才有第二身份 = 被审任务的
// 工作目录 —— 那是**显式**的归属，不是猜的。
//
// 两版「消歧」都被证伪，这一份把它们钉成回归：
//   · 「先按证据目录解、加载失败再换工作目录」—— 加载失败只能证明此刻取不到（第 2 轮 F1）；
//   · 「问服务端要这一轮的清单，不在清单里就算工作目录的」—— 清单只能回答「现在有没有」。
//     证据文件被删掉之后那一处就被判成工作目录的，于是把同名的另一张图端上来（第 3 轮 R3
//     第 1 条实测：naturalWidth=400 的另一张蓝图）；清单取不到、还在路上时又只能退回上一版。
//
// 这一份只钉纯函数那一层。真实表面的三处接线（团队证据、自由工作流面板、孤立报告弹窗）由
// test:markdown-images 的 DOM 用例覆盖。
import assert from "node:assert/strict";

// markdownPolicy 用 window.location.origin 判同源（站内地址才给灯箱/证据接口）。
globalThis.window = { location: { origin: "https://ash.local" } };
const policy = await import("../src/components/markdownPolicy.ts");
const { reportFileResolver, siblingResolverForUrl, reviewFileTarget } = policy;

const urlFor = (name) => `/api/tasks/T1/review/file?round=2&name=${encodeURIComponent(name)}`;
const resolve = reportFileResolver(urlFor, "T1");

// ① 相对路径恒落在这份文档自己那个目录上（含子目录），**而且不留 fallback**：留了就等于
// 「加载失败再换一个根」，又回到被证伪的那一版。
for (const name of ["shot.png", "./shot.png", "notes.md", "shots/deep.png"]) {
  const resolved = resolve(name);
  assert.match(resolved?.url ?? "", /\/review\/file\?round=2/, `${name} 的地址应是证据接口`);
  assert.equal(resolved?.fallback, undefined, `${name} 不该留「失败就换根」的退路`);
}

// ② **证据文件此刻在不在，一个字都不参与判定**。这里没有任何清单可问：同一个名字无论证据
// 目录里有没有它，解出来都是证据接口的地址 —— 取不到就如实报「图取不到」，不许把工作目录
// 里同名的另一张图冒充成它（R3 第 1 条）。
assert.equal(resolve("missing.png")?.url, resolve("shot.png")?.url?.replace("shot.png", "missing.png"));
assert.match(resolve("missing.png")?.url ?? "", /name=missing\.png/);

// ③ 工作目录那一档只认**显式**身份：绝对路径、`file:`、UNC、盘符。
for (const destination of [
  "/Users/fjh/code/harness/output/current.png",
  "file:///Users/fjh/code/harness/output/current.png",
  "C:\\work\\output\\current.png",
]) {
  assert.match(resolve(destination)?.url ?? "", /\/api\/tasks\/T1\/file\/raw\?path=/, `${destination} 应落在工作目录`);
}
// 不知道是哪个任务时压根没有第二个根。
assert.equal(reportFileResolver(urlFor)("/Users/fjh/x.png"), null);

// ④ 子目录里的补充报告按**它自己那一层**解：`name=notes/supplement.md` 里的 `shot.png`
// 指的是 `notes/shot.png`。丢掉这一层的那一版会把证据根下同名的另一张图端上来（R3 第 4 条
// 实测：弹窗里显示的是根目录那张蓝图，而正文说的是子目录那张红图）。
const nested = siblingResolverForUrl("/api/tasks/T1/review/file?round=2&name=notes%2Fsupplement.md");
assert.equal(nested?.("shot.png")?.url, "https://ash.local/api/tasks/T1/review/file?round=2&name=notes%2Fshot.png");
assert.equal(nested?.("shots/deep.png")?.url, "https://ash.local/api/tasks/T1/review/file?round=2&name=notes%2Fshots%2Fdeep.png");
// 根目录下的报告仍解在根上；自由工作流那条路径一样（run/round 原样留着）。
const flat = siblingResolverForUrl("/api/tasks/T1/free-workflow/review-file?run=R1&round=3&name=report.md");
assert.equal(
  flat?.("shot.png")?.url,
  "https://ash.local/api/tasks/T1/free-workflow/review-file?run=R1&round=3&name=shot.png",
);
// 报告弹窗手上只有报告自己的地址，任务 id 从那个地址里取 —— 绝对路径那一档不能因此丢掉。
assert.match(nested?.("/Users/fjh/x.png")?.url ?? "", /\/api\/tasks\/T1\/file\/raw\?path=/);
// 不是证据接口的地址推不出同目录解析器。
assert.equal(siblingResolverForUrl("/api/uploads/x.png"), undefined);
assert.equal(siblingResolverForUrl("https://example.invalid/review/file?name=a.md"), undefined);

// ⑤ 站外网址里碰巧有同样的磁盘路径形状时不许按它改写：那张图住在别人站上，改写过来只会
// 404，还顺手把「这是谁家的资源」判错（R3 第 5 条）。`file:` 例外 —— 它指的就是本机文件。
assert.equal(reviewFileTarget("https://example.invalid/data/runs/T1/review/round-2/shot.png"), null);
assert.equal(reviewFileTarget("//cdn.example.invalid/data/runs/T1/review/round-2/shot.png"), null);
assert.ok(reviewFileTarget("/Users/fjh/code/harness/data/runs/T1/review/round-2/shot.png"));
assert.ok(reviewFileTarget("file:///Users/fjh/code/harness/data/runs/T1/review/round-2/shot.png"));

// ⑥ 清单那条路连函数都不该剩下：留着就会有人再拿「清单里有没有它」当归属判据。
assert.equal(policy.evidenceListingUrl, undefined, "清单地址推导已撤");

console.log("报告文档根归属回归通过");
