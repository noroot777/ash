// 手机端哨兵条的**请求与操作状态生命周期**（第 9、10 轮审查实测的四条）。
//
// 这两条都只在「同一个组件实例被复用」和「同一任务内部响应乱序」时出现，用真实组件 +
// 真实 React hooks 才看得见（只把原生壳 View/Text/Pressable/Alert、图标和 API 传输换成
// 桩）。审查那份脚本的做法，这里保留下来当回归：
//
// ① **停止状态不许留给下一次**：切走再切回来（普通 push 之外的那种复用）时，上一次停止操作
//    的收尾如果按「现在还是不是这个任务」判断该不该清，就永远清不掉——停止按钮一直灰着，
//    失败提示也不出现，只有重新挂载才能恢复。判据应该是「这是不是我当初按下的那一条」。
// ② **旧那发轮询不许把停掉的卡画回来**：停掉之后那一发 reload 返回空列表，先前挂起的轮询
//    随后回来又把 running 画回去，卡片连停止按钮一起复活。判据是请求序号（最后发出的说话），
//    跟 Web 那边的 seq 同一套。
// ③ **一卡一格**：交替停同一屏上的两条哨兵，后一发不许把前一发的「正在停」挤掉——那会让
//    前一张卡当场又可按（第 10 轮审查不拦项 2）。判据是「哪个任务的哪一条」，不是全组件一
//    个槽。
// ④ **每发一个序号**：同一条哨兵上两发停止请求在飞时（确认框连点两下），先出门那一发的收尾
//    不许放开按钮——它只认「这是不是我按下的那一发」。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chromeLaunchOptions } from "../../web/scripts/chrome-path.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(new URL("../../package.json", import.meta.url));
const esbuild = require("esbuild");

const bundle = await esbuild.build({
  stdin: {
    resolveDir: repo,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { MonitorStrip } from "${repo}mobile/src/components/MonitorStrip.tsx";
      window.mock = { alerts: [], lists: {}, polls: [], deferredPoll: false, pollResolve: null, stops: [], stopResolve: null, stopReject: null };
      for (const taskId of ["A", "B"]) {
        window.mock.lists[taskId] = [{ id: "mon-" + taskId, taskId, kind: "ash", status: "running", description: "任务" + taskId + "的监听", events: 1 }];
      }
      // 轮询定时器交给测试自己踩，别真等 10 秒
      window.setInterval = (callback) => { window.mock.polls.push(callback); return window.mock.polls.length; };
      window.clearInterval = () => {};
      function Harness() {
        const [taskId, setTaskId] = useState("A");
        const [epoch, setEpoch] = useState(0);
        return (
          <>
            <button onClick={() => setTaskId("A")}>切A</button>
            <button onClick={() => setTaskId("B")}>切B</button>
            <button onClick={() => setEpoch(epoch + 1)}>重新挂载</button>
            <MonitorStrip key={epoch} taskId={taskId} visible={true} />
          </>
        );
      }
      createRoot(document.getElementById("app")).render(<Harness />);
    `,
  },
  bundle: true, write: false, format: "iife", jsx: "automatic",
  plugins: [{
    name: "native-shell-only",
    setup(build) {
      build.onResolve({ filter: /^(react-native|@expo\/vector-icons|@\/lib\/api|@\/lib\/theme)$/ }, (args) => ({ path: args.path, namespace: "shell-mock" }));
      build.onLoad({ filter: /.*/, namespace: "shell-mock" }, (args) => ({
        loader: "jsx",
        resolveDir: repo,
        contents: {
          "react-native": `import React from "react";
            export const View = ({children}) => <div>{children}</div>;
            export const Text = ({children}) => <span>{children}</span>;
            export const Pressable = ({children,onPress,disabled,accessibilityLabel}) => <button onClick={onPress} disabled={disabled} aria-label={accessibilityLabel}>{children}</button>;
            export const Alert = { alert: (...args) => window.mock.alerts.push(args) };`,
          "@expo/vector-icons": `export const Ionicons = ({name}) => name === "stop-circle-outline" ? "停止" : "●";`,
          "@/lib/theme": `export const useTheme = () => ({}); export const radius = {sm:2}; export const fonts = {mono:"monospace"};`,
          "@/lib/api": `export const api = {
            taskMonitors: (taskId) => window.mock.deferredPoll
              ? new Promise((resolve) => { window.mock.pollResolve = resolve; window.mock.deferredPoll = false; })
              : Promise.resolve(window.mock.lists[taskId]),
            stopMonitor: () => new Promise((resolve, reject) => {
              window.mock.stops.push({ resolve, reject });
              window.mock.stopResolve = resolve; window.mock.stopReject = reject;
            }),
          };`,
        }[args.path],
      }));
      build.onResolve({ filter: /^react(\/.*)?$/ }, (args) => ({ path: require.resolve(args.path) }));
    },
  }],
});

const browser = await chromium.launch({ ...await chromeLaunchOptions(), headless: true });
const context = await browser.newContext({ viewport: { width: 620, height: 600 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.setDefaultTimeout(5000);
try {
  await page.setContent('<html lang="zh"><meta charset="utf-8"><body><div id="app"></div></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const stopA = page.getByRole("button", { name: "停掉哨兵「任务A的监听」" });
  /** 按下「停掉」并走完确认框，等按钮真的灰下去（= 这一发请求已经出门）。 */
  const confirmStop = async (button, label) => {
    await button.click();
    await page.evaluate(() => window.mock.alerts.at(-1)[2][1].onPress());
    await page.waitForFunction(
      (name) => document.querySelector(`button[aria-label="${name}"]`)?.disabled === true,
      label,
    );
  };

  // ── ① 同一实例复用：过期的停止操作自己收尾，不许把按钮永久按住 ──────────────
  await confirmStop(stopA, "停掉哨兵「任务A的监听」");
  await page.getByRole("button", { name: "切B", exact: true }).click();
  await page.getByRole("button", { name: "停掉哨兵「任务B的监听」" }).waitFor();
  await page.getByRole("button", { name: "切A", exact: true }).click();
  await stopA.waitFor();
  await page.evaluate(() => window.mock.stopReject(new Error("受控网络失败")));
  await page.waitForTimeout(100);
  assert.equal(await stopA.isDisabled(), false, "切走再切回来之后，停止按钮不该还灰着（不重新挂载也能再按）");
  assert.equal(
    await page.evaluate(() => window.mock.alerts.length), 1,
    "切走之后那次失败不该弹到新一屏上（提示仍只有最初那一条确认框）",
  );

  // ── ② 停掉之后，先前挂起的那发轮询不许把卡画回来 ────────────────────────────
  await page.evaluate(() => { window.mock.deferredPoll = true; window.mock.polls.at(-1)(); });
  await confirmStop(stopA, "停掉哨兵「任务A的监听」");
  await page.evaluate(() => { window.mock.lists.A = []; window.mock.stopResolve(); });
  await page.waitForTimeout(100);
  assert.equal(await stopA.count(), 0, "停掉之后那一发 reload 返回空列表，卡片该消失");
  await page.evaluate(() => window.mock.pollResolve([
    { id: "mon-A", taskId: "A", kind: "ash", status: "running", description: "任务A的监听", events: 1 },
  ]));
  await page.waitForTimeout(100);
  assert.equal(await stopA.count(), 0, "旧那发轮询回来不该把已经停掉的卡画回去（请求序号认最后发出的那一发）");
  // ── ③ 一卡一格：交替停两条哨兵，后一发不许把前一发的「正在停」挤掉 ─────────────
  await page.evaluate(() => {
    window.mock.lists.A = [
      { id: "mon-A", taskId: "A", kind: "ash", status: "running", description: "任务A的监听", events: 1 },
      { id: "mon-A2", taskId: "A", kind: "ash", status: "running", description: "任务A的第二条", events: 1 },
    ];
    window.mock.stops = [];
  });
  await page.getByRole("button", { name: "重新挂载", exact: true }).click();
  const stopA2 = page.getByRole("button", { name: "停掉哨兵「任务A的第二条」" });
  await stopA2.waitFor();
  await confirmStop(stopA, "停掉哨兵「任务A的监听」");
  await confirmStop(stopA2, "停掉哨兵「任务A的第二条」");
  assert.equal(await stopA.isDisabled(), true, "停了第二条不该把第一条放开（一卡一格，不是全组件一个槽）");
  await page.evaluate(() => window.mock.stops[1].reject(new Error("受控网络失败")));
  await page.waitForFunction(() => document.querySelector('button[aria-label="停掉哨兵「任务A的第二条」"]')?.disabled === false);
  assert.equal(await stopA.isDisabled(), true, "第二条收尾只清自己那一格，第一条还在飞不该被放开");
  await page.evaluate(() => window.mock.stops[0].reject(new Error("受控网络失败")));
  await page.waitForFunction(() => document.querySelector('button[aria-label="停掉哨兵「任务A的监听」"]')?.disabled === false);

  // ── ④ 每发一个序号：同一条上两发请求，先出门那一发的收尾不许放开按钮 ───────────
  await page.evaluate(() => { window.mock.stops = []; });
  await stopA.click();
  await page.evaluate(() => { const press = window.mock.alerts.at(-1)[2][1].onPress; press(); press(); });
  await page.waitForFunction(() => window.mock.stops.length === 2);
  await page.evaluate(() => window.mock.stops[0].reject(new Error("受控网络失败")));
  await page.waitForTimeout(100);
  assert.equal(await stopA.isDisabled(), true, "同一条上两发请求：较早那发收尾不许放开按钮（认的是哪一发，不只是哪一条）");
  await page.evaluate(() => window.mock.stops[1].resolve());
  await page.waitForFunction(() => document.querySelector('button[aria-label="停掉哨兵「任务A的监听」"]')?.disabled === false);

  assert.deepEqual(errors, [], "组件不该抛错");
} finally {
  await context.close();
  await browser.close();
}
console.log("✓ 手机哨兵条：过期的停止操作自己收尾 / 旧轮询不会把停掉的卡画回来 / 停止标记认得出「哪一张卡的哪一发」");
