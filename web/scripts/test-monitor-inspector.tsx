import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS,
  canStopMonitor, monitorDurationOptions, normalizeMonitorDto, normalizeMonitorTimeout,
  type TaskMonitor,
} from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import type { InspectorDescriptor } from "../src/inspector/types.ts";
import { formatInstant } from "../src/task-detail/utils.ts";
import { MonitorInspector } from "../src/monitors/MonitorInspector.tsx";
import { MonitorWaitCard } from "../src/monitors/MonitorWaitCard.tsx";
import { withMonitorTab } from "../src/monitors/useMonitorInspector.tsx";
import type { TaskMonitorsState } from "../src/monitors/useTaskMonitors.ts";

const base: TaskMonitor = {
  id: "m1",
  taskId: "task",
  // 出身。缺了它卡片会按「只读投影」渲染（没有停止按钮、没有事件数、没有「看它的输出」），
  // 整份夹具的断言全部对不上——这两个字段是必填契约的一部分，不是可选装饰。
  kind: "ash",
  nativeId: null,
  lifetime: "bounded",
  command: "tail -F build.log | grep --line-buffered ERROR",
  description: "盯构建日志",
  cwd: "/repo",
  status: "running",
  pid: 4242,
  events: 3,
  exitCode: null,
  startedAt: "2026-08-25T10:00:00.000Z",
  // 这个起点**作数**（服务端的 `monitorStartTrusted` 说了算）。它和 `startedAt` 是两列
  // 而不是一列的理由见下面那一节：`startedAt` 在历史投影上会退化成占位值，而退化值照样是
  // 个合法日期，前端自己分不出来。
  startedAtExact: true,
  expiresAt: "2026-08-25T12:00:00.000Z",
  // 时长独立于起点：起点不确定时对外只有这一列（卡片改说「总共盯 X（起点不确定）」）。
  timeoutMs: 7_200_000,
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


function state(monitors: TaskMonitor[], recovery: TaskMonitorsState["recovery"] = null): TaskMonitorsState {
  return {
    monitors,
    recovery,
    stoppingIds: new Set(),
    error: null,
    needsWakeTarget: false,
    ready: true,
    start: async () => true,
    stop: async () => undefined,
    reload: async () => undefined,
  };
}

/** 默认是「已确认没有待恢复的事实」——`null` 是另一回事（见下面的第三态）。 */
const panel = (monitors: TaskMonitor[], blockedReason: string | null = null) =>
  renderToStaticMarkup(
    <MonitorInspector
      monitors={state(monitors, { pending: false, reasons: [], attempts: 0, exhausted: false })}
      blockedReason={blockedReason}
    />,
  );

/** 面板 + 一份「还没读完」的恢复状态。 */
const panelPending = (monitors: TaskMonitor[]) => renderToStaticMarkup(
  <MonitorInspector
    monitors={state(monitors, { pending: true, reasons: ["scan-unfinished"], attempts: 2, exhausted: false })}
    blockedReason={null}
  />,
);

// ── 空面板有两种含义，不能说成同一句话 ──────────────────────────────────────
//
// 「这个任务确实没用过哨兵」和「历史还没读完，先给你看这些」要分开。混成一句时第二种会被
// 当成第一种——而那正是整个功能起点那一幕的翻版（面板说没有，agent 说在等 Monitor 通知）。
{
  const empty = panel([]);
  assert.match(empty, /这个任务上还没有哨兵/, "确实没有时就直说");
  // **第三态：不知道。** 恢复状态自己都没读到（暂态读失败）时，「这个任务没用过哨兵」是
  // 一句没有依据的强断言——那正是整个功能起点那一幕（第 7 轮审查）。
  const unknown = renderToStaticMarkup(
    <MonitorInspector monitors={state([], null)} blockedReason={null} />,
  );
  assert.doesNotMatch(unknown, /这个任务上还没有哨兵/, "拿不到恢复状态时不许断言「没用过」");
  assert.match(unknown, /读不到这个任务的监听恢复状态/, "要如实说读不到");
  const pending = panelPending([]);
  assert.doesNotMatch(pending, /这个任务上还没有哨兵/, "还没读完时不许说「没有哨兵」");
  assert.match(pending, /历史/, "要说清是还没读完");
  assert.match(pending, /还有历史没读完/, "而且说得出是哪一类（MONITOR_RECOVERY_LABEL）");
  // 有卡片时同样要说：那份列表可能只是其中一部分。
  assert.match(panelPending([projected]), /历史监听还没读完/, "有卡片时这条提示也要在");
  assert.match(pending, /正在自动继续/, "还在推的时候就说正在推");

  // **预算用完之后不能再说「正在自动继续」**：那时定时器已经停了，等的是下一次真实请求
  // （第 8 轮审查不拦项 1）。
  const exhausted = renderToStaticMarkup(
    <MonitorInspector
      monitors={state([], { pending: true, reasons: ["scan-failed"], attempts: 8, exhausted: true })}
      blockedReason={null}
    />,
  );
  assert.doesNotMatch(exhausted, /正在自动继续/, "预算用完了就不许说「正在自动继续」");
  assert.match(exhausted, /已重试多次仍没读完/, "要说清试了很多次还没读完");
  assert.match(exhausted, /每次打开这一格都会再推一轮/, "并且说清它怎么继续");
  // 反过来也不许把「已停止」说死：读这份状态的那次请求自己就把预算还回去、又推了一轮，
  // 所以页面上「自动重试已停止」这句话在闭环里从来不成立（第 9 轮审查不拦项 3）。
  assert.doesNotMatch(exhausted, /已停止/, "闭环里它不是停着的：别说成已停止");
  assert.doesNotMatch(exhausted, /这个任务上还没有哨兵/, "预算用完也不许谎称没用过");
}

// ── 时长的说法不能进位成「X 分 60 秒」 ──────────────────────────────────────
//
// 拿不到到期时刻时这两处都改说「总共盯 X」。先拆分钟再对余数四舍五入的话，余数落在
// 59.5~60 秒之间就会写出「1 分 60 秒」（第 6 轮审查不拦项）。
{
  const spanOnly = renderToStaticMarkup(
    <MonitorInspector
      monitors={state([{ ...projected, expiresAt: null, timeoutMs: 119_600 }])}
      blockedReason={null}
    />,
  );
  assert.match(spanOnly, /总共盯 2 分钟/, "119.6 秒说成「2 分钟」，不是「1 分 60 秒」");
  assert.doesNotMatch(spanOnly, /60 秒/, "任何情况下都不该出现 60 秒");

  // 「（起点不确定）」这句话现在只剩**回复框上那张等待卡**一个去处：那里没有起点那一段，
  // 所以必须自带这半句。卡片上它是重复的（起点那一段已经认了），于是传
  // `startSaidSeparately` 关掉——两头要分别钉住，否则「到处都不说」也能让上面那条绿。
  const waiting = renderToStaticMarkup(
    <MonitorWaitCard
      monitors={[{ ...base, expiresAt: null, timeoutMs: 119_600 }]} builtinCount={0}
      status="paused" resumePrompt={null} reviewArmed={false} onOpenPanel={() => undefined}
    />,
  );
  assert.match(waiting, /总共盯 2 分钟（起点不确定）/, "等待卡只显示这一句，所以要自带「起点不确定」");
  assert.doesNotMatch(spanOnly, /起点不确定/, "卡片上起点已经单独说过了，不许再带一遍");
}

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

// ── 每张卡都要说得出它是什么时候挂上的 ──────────────────────────────────────
// 用户 2026-10-20 要的：在这之前整张卡上**一个绝对时刻都没有** —— 还在盯的只说「盯到 X」，
// 结束的只剩一个状态词。于是对账时第一个要问的那件事反而查不到：**会话里那句「我挂了监听」
// 对应的是哪一条**（一个任务上并排躺着四五条描述相近的哨兵是常态）。
//
// 时刻按本地时区渲染，所以期望值走同一个 formatInstant，不写死字符串。
{
  const started = formatInstant(base.startedAt);
  assert.ok(started, "夹具的起点得是个能渲染的时刻，否则下面几条断言是空的");

  const live = panel([base]);
  assert.match(live, new RegExp(`起于 ${started}`), "还在盯的那张要说得出起点");
  assert.match(live, /盯到/, "起点不能把原来的期限挤掉——两个一起看才知道它还剩多久");

  // 结束的那张顺带给出结束时刻：「起于」单给会立刻引出「那它跑了多久、是不是我离开之后
  // 才停的」，而答案就在同一份 DTO 里。
  const ended = panel([{ ...base, status: "exited", exitCode: 0, endedAt: "2026-08-25T11:30:00.000Z" }]);
  assert.match(ended, new RegExp(`起于 ${started}`), "结束的那张同样要说得出起点");
  assert.match(ended, new RegExp(`结束于 ${formatInstant("2026-08-25T11:30:00.000Z")}`), "结束的那张还要说得出什么时候结束的");
  assert.match(ended, /命令自己跑完了/, "结局照旧要说");

  // claude 投影那种也一样：它恰恰是最需要对账的那种（事件数和日志都没有，时刻是仅剩的锚点）。
  assert.match(panel([projected]), new RegExp(`起于 ${started}`), "claude 投影那张也要说得出起点");

  // 还在盯着的不写「结束于」——那一栏此刻还没有答案，编一个出来会被当真。
  assert.doesNotMatch(live, /结束于/, "还在盯着的没有结束时刻可言");
}

// ── 起点不作数的时候，一个时刻都不许画 ──────────────────────────────────────
// 上一版这张卡直接读 `startedAt` 写「起于 X」。那一列在历史投影上是允许退化的（真实起点裁
// 不出来时退到整轮执行的开始时刻、甚至落库时刻），而退化值仍然是个**合法日期** —— 于是
// `formatInstant` 的坏日期分支一个字都挡不住，第 1 轮审查在真实 backfill 上抓到的卡片同一
// 行写着「起于 10/19 10:00 · 总共盯 10 分钟（起点不确定）」：自相矛盾，而用户会信前半句。
//
// 这几条钉的就是那一幕：**可信性由服务端那一列说了算，答不出来就只说答不出来。**
{
  const vague: TaskMonitor = {
    ...projected, startedAtExact: false, expiresAt: null, lifetime: "bounded", timeoutMs: 600_000,
    startedAt: "2026-10-19T02:00:00.000Z", // 退化值：那一整轮执行的开始时刻
  };
  const html = panel([vague]);
  assert.ok(formatInstant(vague.startedAt), "（口径）这个退化值本身是能渲染的——所以挡不住它的只有那一列");
  assert.doesNotMatch(html, new RegExp(`起于 ${formatInstant(vague.startedAt)}`),
    "起点不作数时不许把那个退化值画成「起于 X」——它会被当成确定事实");
  assert.doesNotMatch(html, /起于/, "连「起于」这两个字都不该有：那是一句肯定句");
  assert.match(html, /挂上的时刻不确定/, "但要如实说这一栏答不出来，不是整段消失");
  // 同一行上不许把同一件事说两遍：起点那一段已经认了，期限那一段就别再带「（起点不确定）」。
  assert.match(html, /总共盯 10 分钟/, "盯多久是另一半证据，照常给");
  assert.doesNotMatch(html, /起点不确定/, "「起点不确定」不该在同一行上说第二遍");

  // 结束之后同样守住：那张卡恰恰是事后对账时唯一的依据。
  const ended = panel([{ ...vague, status: "exited", exitCode: 0, endedAt: "2026-10-19T02:05:00.000Z" }]);
  assert.doesNotMatch(ended, /起于/, "结束的那张也不许凭退化值说「起于」");
  assert.match(ended, /挂上的时刻不确定/, "结束的那张照样如实说");
  assert.match(ended, new RegExp(`结束于 ${formatInstant("2026-10-19T02:05:00.000Z")}`),
    "结束时刻是真实落库的，不受起点那一半影响");

  // 反面:持续监听也能有可信起点 —— 所以判据不是「有没有到期时刻」。
  const forever = panel([{ ...projected, lifetime: "persistent", expiresAt: null, timeoutMs: null }]);
  assert.match(forever, new RegExp(`起于 ${formatInstant(base.startedAt)}`),
    "没有到期时刻 ≠ 起点不可信：持续监听的起点照常给");
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

// ── 结束之后那半句要分档说 ──────────────────────────────────────────────────
// 用户来这张卡上找的是「那它为什么没叫醒谁」。四种结束方式说成同一句就会把事实说错：
// 真实页面上抓到的样本是 `exited`（命令自己跑完了），却显示「那个会话已经随进程结束」
// （第 4 轮审查 N1）。结论（不会唤醒任务）对每一档都一样，理由不一样。
{
  const exited = panel([{ ...projected, status: "exited", endedAt: "2026-08-25T11:00:00.000Z" }]);
  // 断言要挑**只有这半句才有**的词:`命令自己跑完了` 同时是 CLAUDE_MONITOR_ENDED_REASON
  // 里那条结束原因,拿它当判据的话,这半句说错了也照样能过(写第一版时就栽在这儿)。
  assert.match(exited, /就没人看见它/, "exited 要说清「它跑完了，但那一轮可能已经没人在看」");
  assert.doesNotMatch(exited, /没命等到结果/, "跑完了就不是「没命等」");
  assert.doesNotMatch(exited, /没有任何去处/, "也不是「进程没了」那一档");
  assert.match(exited, /不会唤醒任务/, "但结论照旧要说出来——这才是用户要的那个答案");

  const lost = panel([{ ...projected, status: "lost", endedAt: "2026-08-25T11:00:00.000Z" }]);
  assert.match(lost, /没有任何去处/, "lost 才是「进程没了，它的通知无处可去」");
  assert.doesNotMatch(lost, /就没人看见它/, "别把失效说成跑完了");

  const stopped = panel([{ ...projected, status: "stopped", endedAt: "2026-08-25T11:00:00.000Z" }]);
  assert.match(stopped, /没命等到结果/, "被停掉/盯满的那两档是「还在等，但已经没命等了」");
  assert.match(stopped, /ash 自己的哨兵/, "每一档都要给出能跨回合等的那条路");
}

// ── 「盯到什么时候」必须如实 ────────────────────────────────────────────────
// claude 内置 Monitor 的期限是来源侧说了算的：它可能持续盯着（没有到期时刻），也可能回执
// 还没到（我们还不知道）。无脑写一句「盯到 X」用户会当真——第 2 轮审查实测来源侧会把请求
// 的 1 小时钳成 30 分钟甚至 10 分钟。
{
  const bounded = panel([{ ...projected, lifetime: "bounded", expiresAt: "2026-08-25T12:00:00.000Z" }]);
  assert.match(bounded, /盯到/, "有来源回执的照常给出到期时刻");

  const persistent = panel([{ ...projected, lifetime: "persistent", expiresAt: null }]);
  assert.match(persistent, /持续盯着/, "持续监听要说清它没有到期时刻");
  assert.doesNotMatch(persistent, /盯到 20/, "持续监听不能编一个到期时刻出来");

  const unknown = panel([{ ...projected, lifetime: "unknown", expiresAt: null }]);
  assert.doesNotMatch(unknown, /盯到 20/, "期限未知时更不能编——编出来的那个会被当真");
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

// ── 旧后端发来的 DTO 没有 kind：两端都要在入口补上，否则本来能停的卡变只读 ──────
//
// 能力判据写的是 `kind === "ash"`，字段缺失时「能停」「有日志」同时为 false。前端先更新、
// 后端还没更新的那段混合部署里，旧后端只会发 ash 哨兵，所以补 "ash" 是确定的（第 13 轮
// 审查 N5）。这里一半测函数本身，一半守住两端入口真的调了它——补了不用等于没补。
{
  const legacy = { ...base, kind: undefined } as unknown as TaskMonitor;
  assert.equal(normalizeMonitorDto(legacy).kind, "ash", "缺 kind 的旧 DTO 要归一成 ash");
  // `startedAtExact` 的兜底方向和 `kind` **相反**：那一列缺失说明后端还不会算这份可信性，
  // 于是只能当「答不出来」。补成 true 等于凭空给旧后端发来的占位值盖章。
  const noExact = { ...base, startedAtExact: undefined } as unknown as TaskMonitor;
  assert.equal(normalizeMonitorDto(noExact).startedAtExact, false,
    "缺 startedAtExact 的旧 DTO 只能当「不作数」——这一列的兜底方向和 kind 相反");
  assert.doesNotMatch(panel([normalizeMonitorDto(noExact)]), /起于/,
    "归一之后那张卡不画时刻（旧后端给不出这份可信性）");
  assert.equal(normalizeMonitorDto(base).startedAtExact, true, "带这一列的不许被改写");
  assert.ok(canStopMonitor(normalizeMonitorDto(legacy).kind), "归一之后它又停得掉了");
  assert.equal(normalizeMonitorDto(projected).kind, "claude", "带 kind 的不许被改写");
  assert.match(panel([normalizeMonitorDto(legacy)]), /停掉哨兵/, "归一后的旧 DTO 照常画出停止入口");
  assert.doesNotMatch(panel([legacy]), /停掉哨兵/, "没归一就是只读——这正是要修的那一幕");

  for (const file of ["../src/lib/apiMonitors.ts", "../../mobile/src/lib/api.ts"] as const) {
    const source = readSource(new URL(file, import.meta.url));
    const list = source.slice(source.indexOf("taskMonitors:"), source.indexOf("stopMonitor:"));
    assert.match(list, /normalizeMonitorDto/, `${file} 的哨兵列表入口要归一旧 DTO`);
  }
}

// ── 回复框上那条「在等哨兵」：折叠那一行照旧只报数 ──────────────────────────────
//
// 重启恰好打断了「落身份 → 起进程 → 回填 pid」那一步时,那一行是 running、pid 空、
// `ended_reason` 上写着受阻原因(server/src/monitor-adopt.ts 的 `notePendingIntent`)。
// 它展开之后该说什么**全归 DOM 测试**(第 22 轮审查 N1 改的就是那几句:监督已经不随认领走,
// 所以「会被叫醒」对它也是真的,该说的是「点停未必停得掉它」)——正文要点开才渲染。
{
  const stuck: TaskMonitor = {
    ...base, id: "m-stuck", pid: null, events: 0,
    endedReason: "server 重启后这一刻认不回它：起进程时没来得及记下 pid（身份边条这一刻读不出来：读盘报错：EIO），"
      + "所以一个信号都没发；这条创建意图原样留着，ash 正在自己按间隔重问身份，认回来就接上日志和期限（日志路径见这一行）",
  };
  const wait = (monitors: TaskMonitor[]) => renderToStaticMarkup(
    <MonitorWaitCard
      monitors={monitors} builtinCount={0} status="paused" resumePrompt={null}
      reviewArmed={false} onOpenPanel={() => undefined}
    />,
  );
  // 这里只管折叠态:正文**要点开才渲染**,静态渲染拿不到点击,所以「展开之后说了什么」一律
  // 归 test-monitor-inspector-dom.mjs 的 `?wait=pending|claimed` 两张台子(第 21 轮审查 N2:
  // 上一版在折叠态上断言「不含『重新叫醒』」,那在任何实现下都成立,等于什么都没查)。
  const shut = wait([stuck]);
  assert.match(shut, /在等 1 个哨兵/, "折叠那一行照旧:在等几个、等的是谁");
  assert.doesNotMatch(shut, /monitor-wait__body/,
    "折叠态连正文都不渲染 —— 这一条钉住上面那句话的前提:正文的断言只能在真点击里做");
}

console.log("✓ 哨兵面板：在盯的能停、结束的说清结局、说得出什么时候挂上的（起点不作数时只说答不出来、不画退化值、同一行不重复），空态留得住入口、用过才浮现且带底色与活信号，创建结果有归属，手机端同样给得出叫停，旧后端 DTO 在入口归一（含起点可信性反向兜底），回复框上那条「在等」折叠态只报数（正文归 DOM 测试点开验）");
