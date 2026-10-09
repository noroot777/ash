import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskMonitor } from "@ash/shared/monitor";
import { readSource } from "../../scripts/read-source.mjs";
import { TaskMonitorStrip, visibleMonitors } from "../src/components/TaskMonitors.tsx";

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

// ── 还在盯的那个必须给得出「停」──────────────────────────────────────────────
// 哨兵的进程是故意脱离 ash 的：agent 的回合、会话、甚至 server 重启都带不走它。代价
// 就是「后台有个进程在跑、每吐一行烧一个回合」这件事再没有第二个地方看得见。所以这一条
// 不是装饰：没有它，用户对一个跑飞的哨兵束手无策。
{
  const html = renderToStaticMarkup(
    <TaskMonitorStrip monitors={[base]} stoppingIds={new Set()} error={null} onStop={() => undefined} />,
  );
  assert.match(html, /盯构建日志/, "哨兵的说明要露在外面");
  assert.match(html, /3 条事件/, "推了多少条事件要看得见——那是花掉的回合数");
  assert.match(html, /停掉哨兵“盯构建日志”/, "在盯的哨兵必须给得出停止入口");
}

// ── 已结束的保留一段时间，并如实说明结局 ─────────────────────────────────────
{
  const exited: TaskMonitor = {
    ...base,
    status: "exited",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    endedReason: "命令自己跑完了",
  };
  const html = renderToStaticMarkup(
    <TaskMonitorStrip monitors={[exited]} stoppingIds={new Set()} error={null} onStop={() => undefined} />,
  );
  assert.match(html, /命令自己跑完了/, "结束的哨兵要说清是怎么结束的");
  assert.match(html, /退出码 0/, "有退出码就报出来");
  assert.doesNotMatch(html, /停掉哨兵/, "已经结束的不该再给停止入口");
}

// ── 太久以前结束的不再占地方 ─────────────────────────────────────────────────
{
  const stale: TaskMonitor = { ...base, status: "stopped", endedAt: "2020-01-01T00:00:00.000Z" };
  assert.equal(visibleMonitors([stale]).length, 0, "很久以前结束的哨兵不该一直挂在对话框上面");
  assert.equal(visibleMonitors([base]).length, 1, "在盯的永远要显示");
  const html = renderToStaticMarkup(
    <TaskMonitorStrip monitors={[stale]} stoppingIds={new Set()} error={null} onStop={() => undefined} />,
  );
  assert.equal(html, "", "一个都不该显示时整条都不出现");
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

console.log("✓ 哨兵条：在盯的能停、结束的说清结局、陈旧的自动收起，手机端同样给得出叫停");
