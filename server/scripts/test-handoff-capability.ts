// 接力的能力握手:目标机跑不跑得动这个任务(server/src/handoff-capability.ts)。
//
// 这个测试钉的不是「能不能发现落差」——那部分一眼就对。真正要钉死的是**哪几档不许拦**:
// 握手是接力路上新加的一道闸,而闸的失败模式是不对称的。漏报只是回到本功能上线前的
// 行为(任务过去之后才失败,有人去翻日志);**误报却会把一条本来能成的接力拦死**,而且
// 拦的理由是一份用户根本无从核实的清单(「我这边明明装了 codex」)。
//
// 所以下面每一条 not-blocking 的断言都对应一个具体的假警报来源:对端旧版报不出能力、
// 对端是多人实例故意没探、模型清单只是发版时抄下的内置快照。它们全都必须放行。
import assert from "node:assert/strict";
import type { HandoffPeerCapabilities } from "@ash/shared";
import { compareCapabilities } from "../src/handoff-capability.ts";

type Need = Parameters<typeof compareCapabilities>[0][number];

const need = (agentType: string, model: string | null = null): Need => ({
  slot: "task", agentType, model, where: "任务当前的执行器",
});

const caps = (
  agents: { type: string; available: boolean; models?: string[]; modelSource?: "probe" | "preset" }[],
  skipped: string | null = null,
): HandoffPeerCapabilities => ({
  agents: agents.map((a) => ({
    type: a.type as HandoffPeerCapabilities["agents"][number]["type"],
    available: a.available,
    profiles: 0,
    models: a.models ?? [],
    modelSource: a.modelSource ?? "preset",
  })),
  skipped,
});

// ── 对得上就是对得上 ────────────────────────────────────────────────────────
{
  const report = compareCapabilities([need("claude")], caps([{ type: "claude", available: true }]));
  assert.equal(report.status, "ok");
  assert.equal(report.blocking, false);
  assert.deepEqual(report.gaps, []);
}

// ── 缺智能体:唯一该拦的一档 ────────────────────────────────────────────────
{
  const report = compareCapabilities(
    [need("codex")],
    caps([{ type: "claude", available: true }, { type: "codex", available: false }]),
  );
  assert.equal(report.status, "gaps");
  assert.equal(report.blocking, true, "对端明确报了「没装 codex」——这一档必须拦在打包之前");
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].kind, "agent-missing");
  assert.match(report.gaps[0].detail, /ENOENT/, "话要说到后果上,不能只报一个类型名");
}

// ── 不许拦之一:对端旧版,报不出能力 ────────────────────────────────────────
// 老版本 ash 的 ping 应答里没有 capabilities 字段。这时一律 unknown 放行 —— 与对端
// 不报身份时的处理同哲学:新功能不能把升级路径一刀切断。
for (const absent of [null, undefined]) {
  const report = compareCapabilities([need("codex")], absent);
  assert.equal(report.status, "unknown");
  assert.equal(report.blocking, false);
  assert.ok(report.unknownReason, "无从核对必须给出原因,而不是静默当成 ok");
  assert.deepEqual(report.gaps, []);
}

// ── 不许拦之二:对端是多人实例,故意没探宿主机 CLI ──────────────────────────
// 隔离档下执行器挂的是各人自己的供应商,宿主机装了什么与「能不能跑」无关。此时
// available=false 不代表跑不起来,拿它拦人就是纯粹的假警报。
{
  const report = compareCapabilities(
    [need("codex", "gpt-5.6-sol")],
    caps([{ type: "codex", available: false, models: [], modelSource: "probe" }], "多人模式不问宿主机 CLI"),
  );
  assert.equal(report.blocking, false, "对端自己说了没去探,它报的 available 就不能当判据");
  assert.deepEqual(report.gaps, [], "模型也不能在这一档报落差");
}

// ── 不许拦之三:模型清单只是内置兜底快照 ────────────────────────────────────
// preset 是发版时抄下来的,各家上新模型跟 ash 发版毫无关系。拿它否定一个模型,等于
// 因为「我这份名单旧」去说用户的模型不存在。
{
  const report = compareCapabilities(
    [need("claude", "opus-9-future")],
    caps([{ type: "claude", available: true, models: ["opus", "sonnet"], modelSource: "preset" }]),
  );
  assert.deepEqual(report.gaps, [], "preset 清单没有资格否定一个模型");
  assert.equal(report.status, "ok");
}

// ── 缺模型:只有实时目录才有资格报,而且只提示不拦 ──────────────────────────
{
  const report = compareCapabilities(
    [need("claude", "opus-9-future")],
    caps([{ type: "claude", available: true, models: ["opus", "sonnet"], modelSource: "probe" }]),
  );
  assert.equal(report.status, "gaps");
  assert.equal(report.blocking, false, "模型对不上不拦:那边可能报错,也可能静默换模型跑完");
  assert.equal(report.gaps[0].kind, "model-missing");
  assert.match(report.gaps[0].detail, /静默/, "「可能静默换个模型跑完」正是用户最该知道的那半句");
}
{
  const report = compareCapabilities(
    [need("claude", "opus")],
    caps([{ type: "claude", available: true, models: ["opus", "sonnet"], modelSource: "probe" }]),
  );
  assert.equal(report.status, "ok", "模型在实时清单里就是对得上");
}

// ── 对端根本不认识这个类型(它比本机老) ────────────────────────────────────
{
  const report = compareCapabilities([need("kimi")], caps([{ type: "claude", available: true }]));
  assert.equal(report.blocking, true);
  assert.match(report.gaps[0].detail, /没有这个智能体类型/);
}

// ── 一个落差只报一次,但不同槽位各报各的 ────────────────────────────────────
// 任务主执行器和待发送消息可能指向同一个缺失的 CLI,重复列出来只是噪音;可「任务本身
// 要用」和「预约的审查要用」是两件不同的事,合并掉会让人以为改一处就够了。
{
  const missing = caps([{ type: "codex", available: false }]);
  const twice = compareCapabilities([need("codex"), need("codex")], missing);
  assert.equal(twice.gaps.length, 1, "同槽位同类型同模型只报一次");

  const bothSlots = compareCapabilities(
    [need("codex"), { slot: "review", agentType: "codex", model: null, where: "已预约的审查" }],
    missing,
  );
  assert.equal(bothSlots.gaps.length, 2, "不同槽位要分别报出来");
  assert.match(bothSlots.gaps[1].detail, /预约审查/);
}

console.log("handoff capability handshake: ok");
