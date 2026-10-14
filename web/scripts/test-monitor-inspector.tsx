import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS,
  monitorDurationOptions, normalizeMonitorTimeout, type TaskMonitor,
} from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import type { InspectorDescriptor } from "../src/inspector/types.ts";
import { MonitorInspector } from "../src/monitors/MonitorInspector.tsx";
import { withMonitorTab } from "../src/monitors/useMonitorInspector.tsx";
import type { TaskMonitorsState } from "../src/monitors/useTaskMonitors.ts";

const base: TaskMonitor = {
  id: "m1",
  taskId: "task",
  // 出身。缺了它卡片会按「只读投影」渲染（没有停止按钮、没有事件数、没有「看它的输出」），
  // 整份夹具的断言全部对不上——这两个字段是必填契约的一部分，不是可选装饰。
  kind: "ash",
  nativeId: null,
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

/** claude 内置 Monitor 的只读投影：另一种出身，能力和上面那种不一样。 */
const projected: TaskMonitor = {
  ...base,
  id: "m-claude",
  kind: "claude",
  nativeId: "b69ym4qzv",
  description: "最终全量回归结果",
  pid: null,
  events: 0,
};

function state(monitors: TaskMonitor[]): TaskMonitorsState {
  return {
    monitors,
    stoppingIds: new Set(),
    error: null,
    ready: true,
    start: async () => true,
    stop: async () => undefined,
    reload: async () => undefined,
  };
}

const panel = (monitors: TaskMonitor[], blockedReason: string | null = null) =>
  renderToStaticMarkup(<MonitorInspector monitors={state(monitors)} blockedReason={blockedReason} />);

// ── 手动表单的时长选项必须真的能兑现 ────────────────────────────────────────
// 原来那张表把「2 小时 / 8 小时 / 24 小时」写死在前端，上限改掉之后整张失真：选「2 小时」
// 实际只盯 5 分钟，而且提交值恰好等于缺省值，连「已钳到边界」的回执都没有，用户完全无从
// 察觉（第 1 轮审查实测三个选项错两个）。所以这里钉的是**选项与服务端边界同源**。
{
  const options = monitorDurationOptions();
  assert.ok(options.length > 0, "总得给得出选项");
  for (const option of options) {
    assert.ok(
      option.ms >= MONITOR_MIN_TIMEOUT_MS && option.ms <= MONITOR_MAX_TIMEOUT_MS,
      `选项「${option.label}」(${option.ms}ms) 落在服务端会钳掉的区间外——用户选了也兑现不了`,
    );
    assert.equal(option.ms, normalizeMonitorTimeout(option.ms), `选项「${option.label}」会被服务端改写`);
  }
  assert.ok(options.some((o) => o.ms === MONITOR_DEFAULT_TIMEOUT_MS), "缺省时长必须在选项里");
  assert.ok(options.some((o) => o.ms === MONITOR_MAX_TIMEOUT_MS), "上限也该给得出来");
}

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

// ── 两种出身的卡不一样，而且差别必须看得见 ──────────────────────────────────
// claude 自带 Monitor 的投影是只读的：进程在智能体自己的进程树里，ash 停不掉、拿不到日志、
// 也数不到事件数。画成和 ash 哨兵一样的后果是用户去点一个注定失败的停止按钮，再把恒为 0
// 的事件数读成「我的过滤条件写错了」。
{
  const html = panel([projected]);
  assert.match(html, /最终全量回归结果/, "投影的说明照样要露在外面");
  assert.match(html, /claude 自带/, "出身要标出来——两种卡在列表里是混排的");
  assert.match(html, /只能看不能停/, "要解释清楚它为什么没有停止按钮");
  assert.doesNotMatch(html, /停掉哨兵/, "ash 停不掉它，就不该画一个注定失败的停止按钮");
  assert.doesNotMatch(html, /条事件/, "事件数 ash 根本数不到，画出来只会被读成「过滤写错了」");
  assert.doesNotMatch(html, /看它的输出/, "它的输出进了智能体自己的会话，ash 这边没有日志可看");
}

// 两种混排时各画各的，不会互相串味。
{
  const html = panel([base, projected]);
  assert.match(html, /停掉哨兵“盯构建日志”/, "混排时 ash 那张照常给停止入口");
  assert.match(html, /claude 自带/, "混排时投影那张照常标出身");
  assert.equal(html.match(/停掉哨兵/g)?.length, 1, "两张卡里只有 ash 那张有停止按钮");
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

// ── 图标条上的那一格：用过才浮现，和子智能体同一条规矩 ──────────────────────────
// 开合不是审美偏好。两头都踩过坑：无条件默认开着（上一版的哨兵）会让大多数任务的图标条
// 上常年挂着一个点进去只有空话的面板；没用过就整格摘掉（上一版的子智能体）又让人翻遍
// 「+」菜单都找不到它，只能得出「这功能没有」。所以**面板一直在、默认不开、用过才自己
// 冒上来并带底色**；手动起哨兵仍然只有这一格里那个「+」，靠的就是它永远在菜单里。
{
  const descriptors: InspectorDescriptor<unknown>[] = [
    { id: "info", title: "信息", icon: null, defaultOpen: true, render: () => null },
    { id: "monitors", title: "哨兵", icon: null, render: () => null },
  ];
  const tab = (live: number, used = live) => withMonitorTab(descriptors, { live, used }).find((d) => d.id === "monitors");

  const empty = tab(0, 0);
  assert.ok(empty, "一个哨兵都没有时这一格也必须还在——「+」菜单和 I M 得找得到它");
  assert.equal(empty?.defaultOpen, false, "没挂过哨兵就不往图标条上冒");
  assert.equal(empty?.title, "哨兵", "没在盯着的就不带数量");
  assert.equal(empty?.icon, descriptors[1].icon, "没挂过的时候图标不该变");

  const ended = tab(0, 2);
  assert.equal(ended?.defaultOpen, true, "挂过就得浮现——跑完的哨兵是干过什么的凭证，不能跟着收走");
  assert.equal(ended?.title, "哨兵", "都结束了就别再冒充活信号");
  assert.match(String((ended?.icon as React.ReactElement<{ className?: string }>).props.className),
    /inspector-rail-icon--used/, "浮现的那一格要带底色记号（和子智能体同一个类名）");

  const busy = tab(2);
  assert.equal(busy?.defaultOpen, true, "有哨兵在盯着当然要浮现");
  assert.match(String(busy?.title), /哨兵（2）/, "标题上的数字是此刻真在烧回合的那几个，不含已经结束的");
  const busyClass = String((busy?.icon as React.ReactElement<{ className?: string }>).props.className);
  assert.match(busyClass, /monitor-rail-icon--live/, "有在盯的哨兵时图标要变（这是面板收起时唯一的活信号）");
  assert.match(busyClass, /inspector-rail-icon--used/, "活信号之外，底色记号照样要在");

  // 开合既然按「用过没用过」给，那两份 descriptor 表上就不许再写死 defaultOpen——写了
  // 就是无条件默认开，这一条规矩当场作废。
  for (const file of ["../src/task-detail/taskInspectors.tsx", "../src/team/TeamInspector.tsx"] as const) {
    const source = readSource(new URL(file, import.meta.url));
    const tail = source.slice(source.indexOf('id: "monitors"'));
    assert.doesNotMatch(tail.slice(0, 240), /defaultOpen/,
      `${file} 里哨兵那一格不许写死 defaultOpen：开合归 useMonitorInspector`);
  }

  // 同理，两处的 defaultOpenTabIds 也不许带上它：那张表在每次语义换挡时无条件并集，
  // 带上等于把「用过才浮现」拆了（子智能体一起，它们是同一条规矩）。
  for (const file of ["../src/task-detail/TaskDetail.tsx", "../src/team/TeamView.tsx"] as const) {
    const source = readSource(new URL(file, import.meta.url));
    for (const [, list] of source.matchAll(/defaultOpenTabIds: ([\s\S]*?)\n\s*defaultActiveTabId/g)) {
      assert.doesNotMatch(list, /"monitors"|"subagents"/,
        `${file} 的 defaultOpenTabIds 不许带哨兵/子智能体：那两格走「用过才浮现」`);
    }
  }

  // 存量用户的 openTabs 里还钉着旧默认，`applyTabPolicy` 是并集语义摘不掉，得靠一次性迁移。
  assert.match(
    readSource(new URL("../src/monitors/useMonitorInspector.tsx", import.meta.url)),
    /retireInspectorTab\(\s*"monitors-surface-on-use"/,
    "改默认开合要连带把存量 openTabs 里的哨兵摘一次，否则老用户那边它永远开着",
  );
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
  // 切出 start 这一段：从它的 useCallback 开头，到第一行「`}, [依赖表]);`」为止。依赖表写了
  // 什么不作数——改依赖不该让这几条断言跟着漂。锚点找不到时必须当场报错：`indexOf` 返回
  // -1 会把切片悄悄放大成「从这里到文件末尾」，下面几条断言照样绿，但它们看的已经不是
  // start 那一段了。
  const from = hook.indexOf("const start = useCallback");
  const end = /^\s*\}, \[[^\]]*\]\);$/m.exec(hook.slice(from));
  assert.ok(from >= 0 && end, "切不出 start 那一段：锚点漂了，先把锚点改对再谈断言");
  const start = hook.slice(from, from + end!.index);
  assert.doesNotMatch(start, /^\s*return true;$/m, "跨任务的创建不许回 true：它唯一的用处是收走当前那张表单");
  assert.match(start, /return mine\(\);/, "起成功了也要先问一句「现在还是这个任务吗」");
  // 忙碌状态归表单实例，不归任务：同一个任务上可以有一张在途的、一张刚重开的。
  assert.doesNotMatch(hook, /setStarting|starting,/, "「正在创建中」不该按任务存——那样取消重开后新表单会被旧请求按住");
}

console.log("✓ 哨兵面板：在盯的能停、结束的说清结局、空态留得住入口、用过才浮现且带底色与活信号，创建结果有归属，手机端同样给得出叫停");
