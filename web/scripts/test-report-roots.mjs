// 报告正文里一处相对路径说的是**证据目录里那一份**，还是**被审任务工作目录里那一份**。
//
// 这个判定曾经是「先给证据目录的地址，加载失败就换工作目录」。加载失败只能证明那个文件
// 此刻取不到，证明不了这处引用说的是另一个根：报告目录里本该有的那张图丢了、而工作目录里
// 刚好有个同名的别的文件时，试出来的那一版会把**别的图**当成证据端上来（审查第 2 轮 F1 的
// 同类位置）。所以判据换成「问服务端这一轮证据目录里有哪些文件」，清单里有才是证据目录。
//
// 这一份只钉纯函数那一层：清单地址怎么从报告地址推出来、给了清单之后根归属怎么算。真实
// 表面的三处接线（团队证据、自由工作流面板、孤立报告弹窗）由 test:markdown-images 的 DOM
// 用例和 useEvidenceNames 那一个 hook 覆盖。
import assert from "node:assert/strict";

// markdownPolicy 用 window.location.origin 判同源（站内地址才给灯箱/证据接口）。
globalThis.window = { location: { origin: "https://ash.local" } };
const { evidenceListingUrl, reportFileResolver } = await import("../src/components/markdownPolicy.ts");

const team = "/api/tasks/T1/review/file?round=2&name=report.md";
const free = "/api/tasks/T1/free-workflow/review-file?run=R1&round=3&name=report.md";

// ① 清单地址 = 文件路由加一个 `s`，run/round 原样留着，只去掉 name。
assert.equal(evidenceListingUrl(team), "https://ash.local/api/tasks/T1/review/files?round=2");
assert.equal(evidenceListingUrl(free), "https://ash.local/api/tasks/T1/free-workflow/review-files?run=R1&round=3");
// 不是证据接口的地址推不出清单（弹窗照旧退回按顺序试）。
assert.equal(evidenceListingUrl("/api/uploads/x.png"), null);
assert.equal(evidenceListingUrl("https://example.invalid/review/file?name=a.md"), null);

const urlFor = (name) => `/api/tasks/T1/review/file?round=2&name=${encodeURIComponent(name)}`;

// ② 给了清单:在清单里 → 证据目录那一份,而且**不留 fallback**(留了就等于「加载失败再
// 换一个根」,又回到试出来的那一版)。
const withList = reportFileResolver(urlFor, "T1", ["shot.png", "notes.md", "shots/deep.png"]);
for (const name of ["shot.png", "notes.md", "shots/deep.png"]) {
  const resolved = withList(name);
  assert.equal(resolved?.name, name, `${name} 应解到证据目录`);
  assert.match(resolved?.url ?? "", /\/review\/file\?round=2/, `${name} 的地址应是证据接口`);
  assert.equal(resolved?.fallback, undefined, `${name} 不该再留一个「失败就换根」的退路`);
}

// ③ 清单里**没有**它 → 被审任务的工作目录(报告里提工作目录里的文件是常事)。
const inWorkspace = withList("output/current.png");
assert.match(inWorkspace?.url ?? "", /\/api\/tasks\/T1\/file\/raw\?path=output%2Fcurrent\.png/);

// ④ **.md 也必须进清单判定**:只给截图清单的那一版会把「指向同目录另一份报告」的链接判成
// 工作目录里的文件(那儿压根没有这一份),于是点开 404 —— 这一条就是只给 screenshots 的回归。
const imagesOnly = reportFileResolver(urlFor, "T1", ["shot.png"]);
assert.match(imagesOnly("notes.md")?.url ?? "", /\/api\/tasks\/T1\/file\/raw/, "清单不全时它只能落到工作目录(所以清单必须给全)");

// ⑤ 清单还没到货(undefined):退回「两个地址都给出去、渲染点按顺序试」那一档降级 ——
// 是降级而不是判据,所以第一地址仍是证据目录,且必须带着 fallback。
const loading = reportFileResolver(urlFor, "T1");
const pending = loading("shot.png");
assert.match(pending?.url ?? "", /\/review\/file\?round=2/, "清单未到时先试证据目录");
assert.match(pending?.fallback?.url ?? "", /\/api\/tasks\/T1\/file\/raw/, "并带着工作目录那一档退路");

// ⑥ 不知道是哪个任务(没有 taskId)时压根没有第二个根:给什么都只解证据目录。
const noTask = reportFileResolver(urlFor);
assert.equal(noTask("shot.png")?.fallback, undefined);
assert.match(noTask("shot.png")?.url ?? "", /\/review\/file\?round=2/);

console.log("报告文档根归属回归通过");
