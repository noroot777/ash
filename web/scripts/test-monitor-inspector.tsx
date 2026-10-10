import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskMonitor } from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import type { InspectorDescriptor } from "../src/inspector/types.ts";
import { MonitorInspector } from "../src/monitors/MonitorInspector.tsx";
import { withMonitorTab } from "../src/monitors/useMonitorInspector.tsx";
import type { TaskMonitorsState } from "../src/monitors/useTaskMonitors.ts";

const base: TaskMonitor = {
  id: "m1",
  taskId: "task",
  command: "tail -F build.log | grep --line-buffered ERROR",
  description: "盯构建日志",
  cwd: "/repo",
  status: "running",
  pid: 4242,
  events: 3,
  exitCode: null,
  startedAt: "2026-08-25T10:00:00.000Z",
  expiresAt: "2026-08-25T12:00:00.000Z",
  endedAt: null,
  endedReason: null,
};

function state(monitors: TaskMonitor[]): TaskMonitorsState {
  return {
    monitors,
    stoppingIds: new Set(),
    error: null,
    start: async () => true,
    stop: async () => undefined,
    reload: async () => undefined,
  };
}

const panel = (monitors: TaskMonitor[], blockedReason: string | null = null) =>
  renderToStaticMarkup(<MonitorInspector monitors={state(monitors)} blockedReason={blockedReason} />);

// ── 在盯的那个必须给得出「停」，并把花掉的回合数摆在明面上 ────────────────────
// 哨兵的进程是故意脱离 ash 的：agent 的回合、会话、甚至 server 重启都带不走它。代价
// 就是「后台有个进程在跑、每吐一行烧一个回合」这件事再没有第二个地方看得见。所以这一条
// 不是装饰：没有它，用户对一个跑飞的哨兵束手无策。
{
  const html = panel([base]);
  assert.match(html, /盯构建日志/, "哨兵的说明要露在外面");
  assert.match(html, /3 条事件/, "推了多少条事件要看得见——那是花掉的回合数");
  assert.match(html, /停掉哨兵“盯构建日志”/, "在盯的哨兵必须给得出停止入口");
  assert.match(html, /grep --line-buffered ERROR/, "命令原文是判断「它到底在盯什么」的唯一依据");
  assert.match(html, /看它的输出/, "能回看原始输出才分得出「还没吐」和「过滤条件写错了」");
}

// ── 已结束的如实说明结局，并且不再给停止入口 ─────────────────────────────────
{
  const html = panel([{
    ...base,
    status: "exited",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    endedReason: "命令自己跑完了",
  }]);
  assert.match(html, /命令自己跑完了/, "结束的哨兵要说清是怎么结束的");
  assert.match(html, /退出码 0/, "有退出码就报出来");
  assert.doesNotMatch(html, /停掉哨兵/, "已经结束的不该再给停止入口");
}

// ── 没有哨兵时这一格仍然可用：空态要解释它是什么，并留着手动起一个的入口 ──────
// 整格藏起来（子智能体那种做法）在这里是错的：那一格的内容由 agent 单方面产生，而哨兵
// 是人也会想自己挂的东西——藏了它，没起过哨兵的任务就再没有第二个地方能起。
{
  const html = panel([]);
  assert.match(html, /还没有哨兵/, "空态要直说现在没有");
  assert.match(html, /每吐一行/, "空态顺带解释清楚哨兵是什么，否则这一格对新用户是个谜");
  assert.match(html, /手动起一个哨兵/, "没有哨兵时也要留着手动起一个的入口");
  const blocked = panel([], "任务已归档，不能再挂哨兵");
  assert.doesNotMatch(blocked, /手动起一个哨兵/, "归档任务上的哨兵早被收回，不该再给新建入口");
  // 按钮凭空消失 = 用户以为功能坏了。不能起就必须把原因写在面板上。
  assert.match(blocked, /任务已归档/, "不给新建入口时要说清为什么");
  assert.doesNotMatch(blocked, /MCP 工具 start_monitor/, "连入口都没有时，别再教人怎么用那个入口");
}

// ── 图标条上的那一格：默认开着，标题/图标按「此刻几个在盯着」给 ───────────────
// 默认开不是审美偏好：手动起一个哨兵只有这一格里那个「+」，藏进「+」菜单就得先知道
// 它在那儿才找得到。所以开合写死在 TASK_INSPECTORS / TEAM_INSPECTORS 里，这个 hook
// 只负责那点活信号。
{
  const descriptors: InspectorDescriptor<unknown>[] = [
    { id: "info", title: "信息", icon: null, defaultOpen: true, render: () => null },
    { id: "monitors", title: "哨兵", icon: null, defaultOpen: true, render: () => null },
  ];
  const tab = (live: number) => withMonitorTab(descriptors, { live }).find((d) => d.id === "monitors");

  const empty = tab(0);
  assert.ok(empty, "一个哨兵都没有时这一格也必须还在");
  assert.equal(empty?.defaultOpen, true, "没哨兵也默认开着——手动起一个哨兵只有这一格里那个入口");
  assert.equal(empty?.title, "哨兵", "没在盯着的就不带数量");
  assert.equal(empty?.icon, descriptors[1].icon, "没在盯着的时候图标不该变");

  const busy = tab(2);
  assert.equal(busy?.defaultOpen, true, "有哨兵时当然还是开着");
  assert.match(String(busy?.title), /哨兵（2）/, "标题上的数字是此刻真在烧回合的那几个，不含已经结束的");
  assert.notEqual(busy?.icon, descriptors[1].icon, "有在盯的哨兵时图标要变（这是面板收起时唯一的活信号）");

  // 真正决定开合的是那两份 descriptor 表，hook 只做装饰：它们上面必须写着 defaultOpen。
  for (const file of ["../src/task-detail/taskInspectors.tsx", "../src/team/TeamInspector.tsx"] as const) {
    assert.match(
      readSource(new URL(file, import.meta.url)),
      /id: "monitors",[\s\S]{0,240}?defaultOpen: true/,
      `${file} 里哨兵那一格必须默认开着`,
    );
  }

  // 光 descriptor 上写 defaultOpen 还不够：存量用户的 openTabs 躺在 localStorage 里，
  // `applyTabPolicy` 只在 stateKey 变过一次时才拿 defaultOpenTabIds 去并集。两处都得
  // 带上它，否则老用户永远等不到它自己冒出来。
  for (const [file, pattern] of [
    ["../src/task-detail/TaskDetail.tsx", /defaultOpenTabIds: \[[^\]]*"monitors"/],
    ["../src/team/TeamView.tsx", /defaultOpenTabIds: allWorkersComplete[\s\S]*?"monitors"[\s\S]*?"monitors"/],
  ] as const) {
    assert.match(readSource(new URL(file, import.meta.url)), pattern,
      `${file} 的 defaultOpenTabIds 必须带上哨兵，否则存量用户那边它不会自己开`);
  }
}

// ── 还在盯的排在上面：结束的那几张是存档，正在烧回合的才要盯着看 ──────────────
{
  const html = panel([
    { ...base, id: "ended", description: "已经跑完的", status: "exited", exitCode: 0, endedAt: new Date().toISOString() },
    { ...base, id: "live", description: "还在盯着的" },
  ]);
  assert.ok(
    html.indexOf("还在盯着的") < html.indexOf("已经跑完的"),
    "还在盯着的哨兵必须排在已结束的前面",
  );
}

// ── 结束原因跟状态标签一字不差时只说一遍 ─────────────────────────────────────
{
  const html = panel([{
    ...base,
    status: "exited",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    endedReason: "命令自己跑完了",
  }]);
  assert.equal(html.split("命令自己跑完了").length - 1, 1, "同一句话不该在一张卡上出现两次");
}

// ── 哨兵只有一个落脚点：回复框上面不再并排一条 ───────────────────────────────
// 同一件事摆两处必然漂移，而且回复框上方每多一行，输入区就矮一行。
for (const file of ["../src/task-detail/ReplyBox.tsx", "../src/team/TeamView.tsx"]) {
  const source = readSource(new URL(file, import.meta.url));
  assert.doesNotMatch(source, /TaskMonitorStrip/, `${file} 不该再并排一条哨兵，它已经整格搬进 Inspector`);
}

// ── 手机端同样要有「叫停」这一下 ─────────────────────────────────────────────
// 人不在电脑前的时候恰恰最需要它：哨兵每推一条事件就唤醒任务跑一个真回合。只在桌面端
// 给停止入口，等于让用户眼睁睁看着它烧到自己走回电脑前。
{
  const strip = readSource(new URL("../../mobile/src/components/MonitorStrip.tsx", import.meta.url));
  assert.match(strip, /api\.stopMonitor/, "手机端哨兵条必须能真的停掉它");
  assert.match(strip, /Alert\.alert\([\s\S]*style: "destructive"/, "停止是不可逆的，手机上要先确认");
  assert.doesNotMatch(strip, /api\.startMonitor|\/monitors",\s*\{\s*method: "POST"/, "手机上没有手动起哨兵的入口");
  const tray = readSource(new URL("../../mobile/src/components/PendingMessageTray.tsx", import.meta.url));
  assert.ok(
    tray.indexOf("m.origin ?") < tray.indexOf("m.sessionRole ?"),
    "哨兵事件要在 sessionRole 之前先分出去，否则会掉进「可撤回」那一支",
  );
  const monitorBranch = tray.slice(tray.indexOf("m.origin ?"), tray.indexOf("m.sessionRole ?"));
  assert.doesNotMatch(monitorBranch, /onRestoreText|withdraw\(/, "哨兵事件不是用户写的，不得提供撤回回填");
  assert.match(monitorBranch, /cancelPending\(m\)/, "哨兵事件只保留「取消这次唤醒」");
}

// ── 「起成功了」是一句有归属的话 ─────────────────────────────────────────────
// 调用方拿这个返回值只做一件事：把表单收起来。所以切走之后它必须回 false —— 此刻屏幕上
// 那张表单已经是另一个任务的了，里面往往还有没提交的草稿。
//
// 为什么这一条是源码断言、而不是像忙碌标记那半截一样从 DOM 上验：今天唯一的调用方把这一
// 格挂在按任务取 key 的 `InspectorHost` 下，切任务时整格连表单一起重挂，于是「跨任务的
// 成功回调收走了当前表单」在 DOM 上看不见（忙碌标记那半截看得见，因为它住在 hook 里、
// 跨任务活着，见 test-monitor-inspector-dom.mjs）。但这是 hook 对外的契约，下一个调用方
// 未必重挂，而届时丢的是用户打的字 —— 所以守在这里。
{
  const hook = readSource(new URL("../src/monitors/useTaskMonitors.ts", import.meta.url));
  const start = hook.slice(hook.indexOf("const start = useCallback"), hook.indexOf("return { monitors,"));
  assert.doesNotMatch(start, /^\s*return true;$/m, "跨任务的创建不许回 true：它唯一的用处是收走当前那张表单");
  assert.match(start, /return mine\(\);/, "起成功了也要先问一句「现在还是这个任务吗」");
  // 忙碌状态归表单实例，不归任务：同一个任务上可以有一张在途的、一张刚重开的。
  assert.doesNotMatch(hook, /setStarting|starting,/, "「正在创建中」不该按任务存——那样取消重开后新表单会被旧请求按住");
}

console.log("✓ 哨兵面板：在盯的能停、结束的说清结局、空态留得住入口、默认开着且带活信号，创建结果有归属，手机端同样给得出叫停");
