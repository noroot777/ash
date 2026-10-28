// 「放弃管理」之后界面还摆着停止按钮 —— 第 1 轮审查 F3 在真实页面上实测:显式放弃后
// 弹层里 0 颗启动按钮、1 颗停止按钮,点下去后端回 `{"stopped":false}`,刷新依旧。
//
// 成因不是漏了一处,而是**判据被抄成了两份**:`sessionRunning` 这一支排除了 abandoned,
// 「配了停止命令 + 上次正常退出 + 没被停过」那一支没排除;服务端 openSession 则是把
// abandoned 放在**所有兜底之前**一刀切掉。所以这里钉的是投影层本身:
// `managedOpen` 必须让「放弃过的永远不算还被管着」盖住后面每一档兜底,而残留端口/PID
// 的事实一个字都不能因此消失。
import assert from "node:assert/strict";
import {
  bestSession, leftoversOf, managedOpen, needsHandoff, sessionRunning, sessionState,
} from "../src/workspace/commandSessionState.ts";

const residue = (extra = {}) => ({
  at: 1, owedPids: [4321], taggedPids: [4321], ports: [8787], portState: "ours",
  notice: "端口 8787 上还有人在听,这几个号留给你自己处理", ...extra,
});
const session = (extra = {}) => ({
  id: "s1", projectId: "p1", cwd: "/tmp", shell: "zsh", name: "dev", commandId: "service",
  startedAt: 100, exitCode: null, stoppedByUser: false, groupAlive: false,
  ports: [], portsAlive: false, portsTruncated: false, stop: { kind: "none" }, ...extra,
});

// ① 放弃过的那一档盖住**每一种**还开着的说法 —— 逐档过一遍,别只过复现出来的那一条路。
//    每一档都跑两遍:服务端带 `running: false` 来(真实载荷 —— 它那边已经一刀切过了,所以
//    劈叉只能出在前端的兜底支上,实测那条路就是这样),以及 `running` 缺省、前端自己从
//    进程/端口/欠账推导的那条退路(别的调用点、旧载荷会走到它)。
const openings = {
  "进程组还有活进程": { groupAlive: true },
  "端口还有人听": { ports: [8787], portsAlive: true },
  "端口归属核不上": { portUncertain: true },
  "上次停止留下没核销的号": { stop: { kind: "unresolved", pids: [4321], complete: true, why: "核不上归属" } },
  // 这一条就是实测复现出来的那条路:连端口都没打印,仅凭「配了停止命令」兜底。
  "配了停止命令 + 正常退出 + 没被停过": { exitCode: 0 },
};
for (const [what, shape] of Object.entries(openings)) {
  for (const [how, authority] of Object.entries({ "服务端已判定不在跑": { running: false }, "running 缺省、前端自己推导": {} })) {
    const where = `${what} / ${how}`;
    const abandoned = session({ ...shape, ...authority, abandoned: residue() });
    assert.equal(sessionRunning(abandoned), false, `放弃之后不该还算在跑(${where})`);
    assert.equal(managedOpen(abandoned, "npm stop"), null, `放弃之后不该还算被 ash 管着(${where})`);
    assert.equal(needsHandoff(abandoned), false, `已经放弃过,不该再给第二次「我自己处理了」(${where})`);
    assert.equal(sessionState(abandoned, managedOpen(abandoned, "npm stop") !== null, true).text,
      "已放弃管理（残留自理）", `放弃之后的文案只能说放弃(${where})`);
  }
}

// ② 停止按钮摆不摆,跟「这一行怎么写」是同一个判据算出来的:managedOpen 为 null
//    就不能出现「已启动」。
const abandonedOpen = session({ exitCode: 0, abandoned: residue() });
assert.equal(sessionState(abandonedOpen, managedOpen(abandonedOpen, "npm stop") !== null, true).text,
  "已放弃管理（残留自理）");

// ③ 放弃不抹掉残留事实:账上那几个号还在,弹层和状态文案照旧交代得出来。
const owed = session({
  stop: { kind: "unresolved", pids: [4321, 4322], complete: true, why: "核不上归属" },
  abandoned: residue({ owedPids: [4321, 4322] }),
});
assert.deepEqual(leftoversOf(owed), [4321, 4322], "放弃不等于核销,账上的号必须还举得出来");
assert.deepEqual(owed.abandoned.ports, [8787], "放弃那一刻的端口快照不许被抹掉");
assert.equal(sessionState(session({ abandoned: residue({ notice: "探不到任何残留" }) })).text,
  "已放弃管理（当时无残留）", "当时确实干净的那种要说清,别一律说成残留自理");

// ④ 反向:没放弃过的时候,那几档兜底一个都不能跟着被砍掉 —— 否则守护化的服务会脱管,
//    再点一次启动就起第二份(第 2 轮审查发现 1 的老账)。
assert.notEqual(managedOpen(session({ exitCode: 0 }), "npm stop"), null, "配了停止命令的正常退出仍算开着");
assert.equal(managedOpen(session({ exitCode: 0 }), null), null, "没有停止命令、也没有活证据 = 真退了");
assert.equal(managedOpen(session({ exitCode: 0, stoppedByUser: true }), "npm stop"), null, "用户自己停过的不算开着");
assert.notEqual(managedOpen(session({ portUncertain: true, exitCode: 0 }), null), null, "端口归属待确认仍算开着");
assert.equal(managedOpen(null, "npm stop"), null, "压根没会话就没什么可停");

// ⑤ 一条命令挑哪条会话也走同一份判据:放弃过的那条不该再被当成「活的」顶上来,
//    否则列表第一眼就把停止按钮摆回去了。
const picked = bestSession([
  session({ id: "old", startedAt: 10, exitCode: 0 }),
  session({ id: "abandoned", startedAt: 200, running: true, abandoned: residue() }),
], "p1", "service");
assert.equal(picked.id, "abandoned", "最新那条仍然是它(历史要看得见)");
assert.equal(managedOpen(picked, "npm stop"), null, "但它不该再被当成还被管着");

console.log("PASS: abandoned launches are never managed-open on any surface, and the residue facts survive");
