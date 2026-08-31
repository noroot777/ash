// 手机端新建项目的路径推导。跑：cd mobile && npm run test:project-path
// （mobile 不是 npm workspace 成员，自己一套 node_modules，所以不走 `npm -w`。）
//
// 钉的是第 1 轮审查那条 P1：身份（`api.me()`）是异步问回来的，用户完全可能**先**打完
// 项目名、身份**后**到。当时「自动填的目录名」存在 state 里，身份到位那一刻没人去补，
// 于是目录名一直空着，提交时整条路径丢掉、请求体只剩 `{ name }`。
//
// 现在目录名是按项目名现算的，所以两种顺序必须给出同一个结果 —— 下面就按事件序列喂。
import assert from "node:assert/strict";
import { projectPathOf, scopedTail, separatorOf } from "../src/lib/projectPath.ts";

const HOME = "/srv/ash-root/xiaocai";

/** 把这一屏的状态机跑一遍：事件按数组顺序发生，最后给出会提交的那条路径。 */
function run(events) {
  const state = { name: "", home: null, typedTail: "", tailTouched: false, repoPath: "" };
  for (const event of events) Object.assign(state, event);
  const tail = scopedTail(state.name, state.typedTail, state.tailTouched);
  return {
    tail,
    path: projectPathOf(state.home, tail, state.repoPath),
  };
}

// ① 审查报告里的那条序列：先打名字，身份后到。
const late = run([{ name: "Frontend" }, { home: HOME }]);
assert.equal(late.tail, "Frontend", "身份晚到也要把项目名填进目录名");
assert.equal(late.path, `${HOME}/Frontend`, `身份晚到时路径不许丢：${JSON.stringify(late)}`);

// ② 反过来：身份先到，再打名字。两条序列结果必须一致。
const early = run([{ home: HOME }, { name: "Frontend" }]);
assert.deepEqual(early, late, "两种到达顺序必须给出同一个结果");

// ③ 手动改过目录名之后，项目名不再倒灌。
const typed = run([
  { home: HOME },
  { name: "Frontend" },
  { typedTail: "my-dir", tailTouched: true },
  { name: "改了个名字" },
]);
assert.equal(typed.path, `${HOME}/my-dir`, "手动填过的目录名不许被项目名覆盖");

// ④ 名字里的路径分隔符不许穿透成第二层目录。
assert.equal(run([{ home: HOME }, { name: "a/b" }]).path, `${HOME}/a-b`);

// ⑤ 目录名空着 = 这次先不设目录（服务端拒绝「目录根本身」，不能拼一条注定被拒的路径）。
assert.equal(run([{ home: HOME }]).path, "");

// ⑥ 不锁前缀那一档（自用模式 / 实例管理员）照旧用自由输入的那条完整路径。
assert.equal(run([{ name: "Frontend" }, { repoPath: " ~/code/foo " }]).path, "~/code/foo");

// ⑦ Windows 的家目录用反斜杠拼。
assert.equal(separatorOf("D:\\ash-root\\me"), "\\");
assert.equal(
  projectPathOf("D:\\ash-root\\me", "foo", ""),
  "D:\\ash-root\\me\\foo",
);

console.log("mobile project path: ok");
