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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

// ── 上报侧:模型那一半必须真的去问 ─────────────────────────────────────────
// 第 1 轮审查抓到的缺口:上报固定报内置快照(modelSource 恒为 preset),而判定侧
// 「只有实时目录才有资格否定模型」那条规矩会让模型落差**永远**报不出来 —— 整个
// model-missing 分支成了死代码,而缺模型正是这个功能要覆盖的两种情况之一。
//
// 所以这里不能只钉「探到什么就如实标什么」:那在没装 grok/pi 的机器上恒真,把写死
// preset 的旧代码也一起放行了 —— 正是那种「看机器脸色」的用例让上面那个缺口活到了
// 审查。改成**自己造一个装了的 CLI**:临时目录里放一个假 grok(能应 `--version`,
// `models` 印出 grok 的清单格式),PATH 前置。于是「有没有去问」在任何机器上都有确定
// 答案 —— 探了就会拿到这份假清单,没探就只能是内置快照。
const fakeCliDir = process.platform === "win32" ? null : mkdtempSync(join(tmpdir(), "ash-fake-cli-"));
const FAKE_MODELS = ["fake-alpha", "fake-beta"];
if (fakeCliDir) {
  const bin = join(fakeCliDir, "grok");
  writeFileSync(bin, [
    "#!/bin/sh",
    'if [ "$1" = "models" ]; then',
    '  printf "Default model: fake-alpha\\nAvailable models:\\n  * fake-alpha (default)\\n  - fake-beta\\n"',
    "else",
    '  echo "0.0.0-fake"',
    "fi",
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.PATH = `${fakeCliDir}${delimiter}${process.env.PATH ?? ""}`;
}

{
  process.env.ASH_DB = process.env.ASH_DB ?? "/tmp/handoff-capability-unit.db";
  const { ensureSchema } = await import("../src/db/index.ts");
  await ensureSchema();
  const { localCapabilities } = await import("../src/handoff-capability.ts");
  const { CLI_MODEL_PRESETS } = await import("@ash/shared/cli-presets");
  const local = await localCapabilities();
  for (const agent of local.agents) {
    if (agent.modelSource === "preset") {
      // preset 就得是那份快照本身,一字不差 —— 包括 trae 这种「CLI 压根没有模型清单
      // 概念」因而快照为空的。标 preset 又给一份别处来的清单,判定侧会当它没资格
      // 否定模型,等于凭空多出一份谁也不认的名单。
      assert.deepEqual([...agent.models], [...CLI_MODEL_PRESETS[agent.type]],
        `${agent.type} 标了 preset,清单却不是内置快照`);
      continue;
    }
    // 反过来:标了 probe 就必须真的是问来的那一份,不能是快照换个名字 —— 那是修复前
    // 的原样,会让整个 model-missing 分支继续是死代码。
    assert.notDeepEqual([...agent.models], [...CLI_MODEL_PRESETS[agent.type]],
      `${agent.type} 标了 probe,清单却和内置快照一模一样`);
    assert.ok(agent.models.length > 0, `${agent.type} 探到了实时目录,清单不该是空的`);
  }

  if (fakeCliDir) {
    const grok = local.agents.find((agent) => agent.type === "grok")!;
    assert.equal(grok.available, true, "PATH 里摆着一个能跑的 grok,却报了没装");
    assert.equal(grok.modelSource, "probe", "上报侧没去问 CLI —— 模型落差这一半会永远报不出来");
    assert.deepEqual([...grok.models], FAKE_MODELS, "报上来的不是问出来的那份清单");

    // 判定侧与上报侧的接缝:上报标了 probe,模型落差就该真的报得出来。这条连起来才是
    // 「model-missing 不是死代码」的完整判据 —— 两侧各自对、接缝错的情况正是修复前。
    const report = compareCapabilities([need("grok", "fake-gamma")], { agents: [grok], skipped: null });
    assert.equal(report.status, "gaps", "实时目录里没有的模型必须报落差");
    assert.equal(report.gaps[0].kind, "model-missing");
    assert.equal(report.blocking, false, "模型落差只提示不拦");
    assert.equal(
      compareCapabilities([need("grok", "fake-beta")], { agents: [grok], skipped: null }).status, "ok",
      "清单里有的模型不该报落差",
    );
  }

  // ── 上报侧的隔离档:一个字都不许问宿主机 ────────────────────────────────
  // 判定侧已经有「对端说了没探就不能拿它拦人」那一条(上面「不许拦之二」)。这里钉的是
  // 上报侧自己:多人隔离实例**根本不该去探**宿主机装了什么 —— §八 的隔离是「宿主机那份
  // 登录态对任务不算数」,把它探出来报给对端,既是白跑一趟,也是把宿主机的安装情况
  // 顺着接力握手漏给了另一台机器。
  //
  // 「没探」的可观测判据就是结果本身:available 全 false、模型清单全是内置快照(上面
  // 那个假 grok 保证了「探了就一定看得出来」)、并且 skipped 得说明白为什么 —— 少了
  // 它,对端只会看到一台「什么都没装」的机器,于是每一条接力都被拦死。
  {
    const { patchAppSettings } = await import("../src/app-settings.ts");
    const { invalidateInstanceConfig } = await import("../src/auth/mode.ts");
    const { resetCapabilityCache } = await import("../src/handoff-capability.ts");
    await patchAppSettings({ instanceMode: "multi", sharedHostCli: false });
    invalidateInstanceConfig();
    resetCapabilityCache();
    const isolated = await localCapabilities();
    assert.ok(isolated.skipped, "隔离档必须说明「我没去探宿主机」,否则对端会当成什么都没装");
    for (const agent of isolated.agents) {
      assert.equal(agent.available, false, `${agent.type}: 隔离档不该上报宿主机的安装情况`);
      assert.equal(agent.modelSource, "preset", `${agent.type}: 隔离档出现 probe 档说明真去问了宿主机 CLI`);
    }
    // 收尾:后面还有别的用例共用这个库。
    await patchAppSettings({ instanceMode: "single", sharedHostCli: false });
    invalidateInstanceConfig();
    resetCapabilityCache();
  }
}

if (fakeCliDir) rmSync(fakeCliDir, { recursive: true, force: true });

console.log("handoff capability handshake: ok");
