import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";
import { assertTone, basis, confirmLayer, deskSettled, gateRow, gateStage, mainButton, openConfirm, run, stateOf } from "./accept-gate-stage.mjs";
import { testAcceptGateRecovery } from "./test-accept-gate-recovery.mjs";
import { testAcceptGateActions } from "./test-accept-gate-actions.mjs";
import { testAcceptGateWaitBar } from "./test-accept-gate-wait-bar.mjs";
import { testAcceptGateReceipts } from "./test-accept-gate-receipt.mjs";
import { testAcceptGateConfirm } from "./test-accept-gate-confirm.mjs";
import { CATCH_UP_RETRY_MS } from "../src/lib/catchUp.ts";
import { fetchesSettled, waitUntil } from "./wait-until.mjs";

// 验收台前提列里「验收前置命令」那一行（acceptance/GateCheck.tsx）。钉住的是在真实页面上才看得出来的事：
//
// ① **在这儿就能把命令设上**（用户 2026-10-23 要求）：想起这件事的时刻就是站在验收台
//    前那一刻。没设命令时前提列里不摆这一行（没东西可拦），入口在确认层的「设一条前置命令」，
//    保存发的是**项目级** PATCH，设置层要说破这一点。
// ② 没有管理权限的人看不到这个入口（确认层的链接、行尾的齿轮都没有）：摆一颗必然 403 的
//    按钮，点的人只会以为是自己点坏了。
// ③ 正在跑的时候不给改（没有齿轮）、只给「停止」，主按钮也锁着：这一次用的是开跑时那条命令原文。
// ④ 红了之后不另摆「重跑 / 跳过」两颗键：它们都是确认层里「运行」那一勾（失败从不被沿用，
//    所以默认勾着 = 重跑，取消 = 这次跳过，层里标出「上次未通过」）。日志默认展开。
// ⑤ 「交给任务」这件事 ash 红了就**自动**做过一次，所以这一行先说清它做没做成：做成了
//    就不再摆这颗键，没做成就得直说「没叫醒任务」。
// ⑥ 「上次那个绿灯还作不作数」有几种不作数（代码变了 / 命令换了 / 准备命令换了），出路一样但原因
//    完全不同，说错一种用户会去查错的地方。
// ⑦ 取消和被打断**不是红**：没有结论，所以不套失败色、也没有「交给任务」。
// ⑧ 归档或任务在跑时「交给任务」跟着禁用 —— 它同样会真的去起一轮。
// ⑨ 命令被撤掉了：这一按就是直接合并，这一行不出，确认层里也没有「运行」那一步。
// ⑩ **权限读不到 ≠ 没有权限**（C3）：②那条「没权限就不摆入口」的前提是「已经读到了角色」。
//    读取失败只是还没读到，它自己会重试到读到，入口随后自己回来。
//
// 姊妹文件装的是**另外几个表面**（这份贴着 700 行上限，按表面拆）：已验收的回执在
// test-accept-gate-receipt.mjs，确认层那几勾 ↔ 发给后端的参数、红行 ↔ 主按钮、基线冲突在
// test-accept-gate-confirm.mjs，主会话页那条「正在跑」的折叠条在 test-accept-gate-wait-bar.mjs，
// 断线重连与任务投影对账在 test-accept-gate-recovery.mjs，真人动作那一道闸在
// test-accept-gate-actions.mjs（读取的并发在它调的 test-accept-gate-reads.mjs）。假服务端在
// accept-gate-stage.mjs。
const web = await startWebServer();

const notice = (page) => page.getByRole("status", { name: "操作结果" });

let browser;
try {
  const base = `${web.origin}/scripts/fixtures/accept-gate.html`;
  browser = await launchChrome();
  const open = gateStage({ browser, base });

  // ① 没设命令：入口在确认层，设完发的是项目级 PATCH，设置层说破「这是项目设置」。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null, basis: null } });
    assert.equal(await gateRow(page).count(), 0, "没设命令时前提列里不摆这一行");
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).count(), 0, "没设命令，这一按不会跑它");
    await layer.getByRole("button", { name: "设一条前置命令", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "前置命令设置", exact: true });
    await settings.waitFor();
    assert.equal(await confirmLayer(page).count(), 0, "去设命令时确认层收起");
    assert.match(await settings.innerText(), /项目设置/, "在任务页上改一个项目设置，必须说破它不只影响这一个任务");
    // 前置命令与准备命令一套改：两格同一颗「保存」，只发改了的那几项。
    await settings.getByLabel("验收前置命令", { exact: true }).fill("  ./kb.sh test full  ");
    await settings.getByLabel("准备命令", { exact: true }).fill("  npm ci --offline  ");
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await notice(page).filter({ hasText: "验收前置命令" }).waitFor();
    assert.deepEqual(store.patches, [{ acceptGateCommand: "./kb.sh test full", acceptGatePrepare: "npm ci --offline" }],
      "两头空白要掐掉再发");
    await settings.waitFor({ state: "detached" });
    await gateRow(page).filter({ hasText: "./kb.sh test full" }).waitFor();
    assert.equal(await stateOf(gateRow(page)), "验收时运行");
    await page.close();
  }

  // ② 成员：确认层里没有「设一条前置命令」，有命令时行尾也没有齿轮。
  for (const command of [null, "./kb.sh test full"]) {
    const { page } = await open({ gate: { command, running: null, latest: null, basis: null }, role: "member" });
    // 「没有入口」只在**读到了** member 之后才有意义：open 已等门禁和项目两发都落完。
    if (command) {
      await gateRow(page).filter({ hasText: command }).waitFor();
      assert.equal(await page.getByRole("button", { name: "前置命令设置", exact: true }).count(), 0);
    }
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("button", { name: "设一条前置命令", exact: true }).count(), 0);
    await page.close();
  }

  // ⑩ 角色读失败只是「还没读到」：不许就此当成「你不是管理员」，它自己要重试到读到。
  {
    const { page, store } = await open({ gate: { command: null, running: null, latest: null }, projectDown: true });
    // 先证「它真的在自己重试」：不碰页面，等到读取次数自己涨过首发那一拨。
    const baseline = store.projectReads;
    await waitUntil(() => store.projectReads > baseline, { timeout: CATCH_UP_RETRY_MS + 10_000,
      message: `读失败要自己重试(间隔 ${CATCH_UP_RETRY_MS}ms)，不是等下一次交互` });
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("button", { name: "设一条前置命令", exact: true }).count(), 0, "还没读到角色时不摆必然 403 的入口");
    // 服务端恢复之后入口要自己回来 —— 旧实现把 503 记成 `false`，它永远不再出现。
    store.projectDown = false;
    await layer.getByRole("button", { name: "设一条前置命令", exact: true }).waitFor({ timeout: CATCH_UP_RETRY_MS + 10_000 });
    await page.close();
  }

  // ③ 正在跑：给的是「停止」，不给改命令；主按钮锁着。
  {
    const running = run({ status: "running", exitCode: null, finishedAt: null, logTail: "正在跑 42/640\n" });
    const { page, store } = await open({ gate: { command: running.command, running, latest: running } });
    const row = gateRow(page);
    await assertTone(row, "running");
    assert.match(await stateOf(row), /^运行中 · \d+/);
    assert.equal(await mainButton(page).isDisabled(), true, "命令占着工作区，这一按不许发");
    assert.equal(await row.getByRole("button", { name: "前置命令设置", exact: true }).count(), 0,
      "跑着的那一次用的是开跑时那条命令，这时摆「改」只会让人以为能中途换一条");
    await row.getByRole("button", { name: "停止", exact: true }).click();
    await notice(page).filter({ hasText: "已取消" }).waitFor();
    assert.equal(store.canceled, 1);
    await gateRow(page).filter({ hasText: "已取消" }).waitFor();
    await deskSettled(page);
    assert.equal(await mainButton(page).isEnabled(), true, "收掉之后这一按就放开了");
    await page.close();
  }

  // ④ 红了：日志就地展开；重跑 / 跳过都在确认层「运行」那一勾上，这一行自己不发起验收。
  {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code", logTail: "2 failed\n" });
    const { page, store } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    const row = gateRow(page);
    await assertTone(row, "failed");
    assert.equal(await stateOf(row), "未通过，还没交给任务");
    assert.equal(await row.locator(".acc-check-main").getAttribute("aria-expanded"), "true", "红在哪一条就在最后几行：默认展开");
    assert.match(await row.locator(".acc-log pre").innerText(), /2 failed/);
    assert.match(await row.locator(".acc-log-head").innerText(), /run-1 · .+ 起 · .+ 止/);
    // 红着也得能就地改命令（最常见的修法就是把命令本身改对）。
    assert.equal(await row.getByRole("button", { name: "前置命令设置", exact: true }).count(), 1);
    for (const name of ["重跑一次", "这次跳过它，直接合并"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
    const layer = await openConfirm(page);
    const runBox = layer.getByRole("checkbox", { name: "运行前置命令" });
    assert.equal(await runBox.isChecked(), true, "失败从不被沿用：默认就是重跑");
    await runBox.uncheck();
    assert.match(await layer.innerText(), /上次未通过/);
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).waitFor();
    await layer.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(store.accepts.length, 0, "开确认层、动那一勾都不发验收");
    await page.close();
  }

  // ⑤ 交给任务：交过之后这一行说「已交给任务修复」，那颗键收起。
  for (const failure of ["exit_code", "entry_missing", "prepare_failed"]) {
    const failed = run({ status: "failed", exitCode: 3, failure });
    const { page, store } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    const row = gateRow(page);
    const what = { exit_code: "未通过", entry_missing: "入口不在被测的树里", prepare_failed: "准备命令没过" }[failure];
    assert.equal(await stateOf(row), `${what}，还没交给任务`);
    await row.getByRole("button", { name: "交给任务", exact: true }).click();
    await notice(page).filter({ hasText: failure === "entry_missing" ? "它会先看入口为什么不在被测的树里" : "已把这条红交给任务去修" }).waitFor();
    assert.equal(store.handoffs, 1);
    await gateRow(page).filter({ hasText: `${what}，已交给任务修复` }).waitFor();
    assert.equal(await row.getByRole("button", { name: "交给任务", exact: true }).count(), 0, "已经在修了，不再摆这颗键");
    await page.close();
  }

  // ⑤ 那次自动交接没叫醒它：这一行必须说破，「交给任务」照常摆着。
  {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code",
      handoff: { at: "2026-10-23T02:00:00.000Z", error: "回合被其它执行抢占，消息未能投递" } });
    const { page } = await open({ gate: { command: failed.command, running: null, latest: failed } });
    assert.equal(await stateOf(gateRow(page)), "未通过，没叫醒任务");
    assert.equal(await gateRow(page).getByRole("button", { name: "交给任务", exact: true }).count(), 1);
    await page.close();
  }

  // ⑥ 上一次的绿灯为什么不作数：代码变了说代码，命令换了说命令，准备命令换了说准备命令。
  for (const [latest, word] of [
    [run({ stale: true, command: "./kb.sh test quick" }), "通过，但命令变了"],
    [run({ stale: true }), "通过，但代码变了"],
    [run({ stale: true, prepareCommand: "npm ci" }), "通过，但准备命令变了"],
  ]) {
    const { page } = await open({ gate: { command: "./kb.sh test full", running: null, latest } });
    const row = gateRow(page);
    assert.equal(await stateOf(row), word);
    await assertTone(row, "idle", "不作数的绿既不是红也不是绿");
    assert.match(await row.locator(".acc-check-text").innerText(), /\.\/kb\.sh test full/, "摆的是现在这条命令");
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).isChecked(), true, "不作数就得重跑");
    await page.close();
  }

  // ⑦ 被取消、被打断的那一次：没有结论 —— 不套失败色，也没有红可以交给任务。
  for (const [status, word] of [["canceled", "已取消"], ["interrupted", "被打断"]]) {
    const stopped = run({ status, exitCode: null, failure: status });
    const { page } = await open({ gate: { command: stopped.command, running: null, latest: stopped } });
    const row = gateRow(page);
    assert.equal(await stateOf(row), word);
    await assertTone(row, "stopped", "取消不是红");
    assert.equal(await row.getByRole("button", { name: "交给任务", exact: true }).count(), 0, "没有结论的那一次，没有「红」可以交给它修");
    await page.close();
  }

  // ⑧ 归档、任务在跑：「交给任务」跟着禁用（它同样会真的去起一轮）。
  for (const guard of ["archived", "running"]) {
    const failed = run({ status: "failed", exitCode: 3, failure: "exit_code" });
    const { page, store } = await open({ gate: { command: failed.command, running: null, latest: failed }, query: `?guard=${guard}` });
    assert.equal(await gateRow(page).getByRole("button", { name: "交给任务", exact: true }).isDisabled(), true);
    assert.equal(await mainButton(page).isDisabled(), true);
    assert.equal(store.handoffs, 0);
    await page.close();
  }

  // ⑨ 命令被撤掉了：这一按就是直接合并，不摆这一行，确认层里也没有「运行」。
  {
    const { page } = await open({ gate: { command: null, running: null, latest: run() } });
    assert.equal(await gateRow(page).count(), 0);
    const layer = await openConfirm(page);
    assert.equal(await layer.getByRole("checkbox", { name: "运行前置命令" }).count(), 0);
    assert.equal(await layer.getByRole("button", { name: "设一条前置命令", exact: true }).count(), 1);
    await page.close();
  }

  await testAcceptGateWaitBar({ open, run });

  {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page, store } = await open({ gate: { command: running.command, running, latest: running }, query: "?wait=1" });
    const bar = page.locator(".accept-gate-wait");
    await bar.locator(".wait-bar__bar").click();
    await bar.getByRole("button", { name: "看完整日志" }).click();
    await bar.getByText("checking 42 / 640", { exact: true }).waitFor();
    store.logText = "NEW PROGRESS 500 / 640";
    await bar.getByRole("button", { name: "刷新日志" }).click();
    await bar.getByText("NEW PROGRESS 500 / 640", { exact: true }).waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const animations = await page.evaluate(() => {
      // 会动的那两档（在跑、等哨兵），侧栏和团队两套类名。
      return ["workspace-status-dot--run", "workspace-status-dot--breathe", "team-status-dot--active", "team-status-dot--working"].map(className => {
        const dot = document.createElement("span");
        dot.className = className;
        document.body.append(dot);
        const style = getComputedStyle(dot);
        // 减少动效时停在原大小（task-status-dot.css 那条 animation: none）。
        const still = style.animationName === "none";
        dot.remove();
        return still;
      });
    });
    assert.deepEqual(animations, [true, true, true, true]);
    await page.close();
  }
  // 日志行里的监督方式说的是**那一次**：下一次的范围不冒充成这一次的；命令撤掉了就整行不出。
  {
    const historical = "历史 macOS 兼容监督，未观察后代可能无法识别";
    const upcoming = "当前平台的下次监督范围";
    for (const command of [null, "new command"]) {
      for (const executionNotice of [null, upcoming]) {
        const { page } = await open({ gate: { command, running: null,
          latest: run({ status: "failed", executionNotice: historical }), executionNotice } });
        if (!command) assert.equal(await gateRow(page).count(), 0);
        else {
          // 最近一次没过的是另一条命令：这一行只说「验收时运行」，那次的日志收在展开层里。
          assert.equal(await stateOf(gateRow(page)), "验收时运行");
          await gateRow(page).locator("button.acc-check-main").click();
          const note = gateRow(page).locator(".acc-log-note");
          assert.equal(await note.innerText(), historical);
          assert.equal(await note.getAttribute("aria-label"), historical);
        }
        assert.equal(await page.getByText(upcoming).count(), 0, "下一次的监督范围不写到这一次的日志头上");
        await page.close();
      }
    }
  }
  for (const wait of [false, true]) {
    const running = run({ status: "running", exitCode: null, finishedAt: null });
    const { page } = await open({ gate: { command: running.command, running, latest: running },
      cancelOutcome: "already_finished", query: wait ? "?wait=1" : "?stage=accepted" });
    if (wait) await page.locator(".wait-bar__bar").click();
    await page.getByRole("button", { name: wait ? "不等了，收掉它" : "停止", exact: true }).click();
    await notice(page).filter({ hasText: "已经结束" }).waitFor();
    assert.doesNotMatch(await notice(page).innerText(), /没有合并|已取消|已收掉/);
    if (!wait) {
      await page.locator('.acc-check[data-check="gate"].is-passed').waitFor();
      assert.equal(await stateOf(gateRow(page)), "通过", "跑完的那次就是这一按的凭据");
    }
    await page.close();
  }
  for (const wait of [false, true]) {
    const pending = run({ status: "interrupted", processPending: true });
    const { page } = await open({ gate: { command: null, running: pending, latest: pending }, query: wait ? "?wait=1" : "" });
    if (wait) {
      await page.locator(".accept-gate-wait").waitFor();
      assert.match(await page.locator(".accept-gate-wait").innerText(), /尚待停止/);
    } else {
      assert.equal(await stateOf(gateRow(page)), "进程还没退干净");
      await assertTone(gateRow(page), "warn");
      assert.equal(await mainButton(page).isDisabled(), true, "进程没退干净，工作区仍被占着");
    }
    await page.close();
  }
  for (const wait of [false, true]) {
    const active = run({ status: "running", exitCode: null });
    const { page } = await open({ gate: { command: active.command, running: active, latest: active },
      query: wait ? "?wait=1" : "", cancelOutcome: "settlement_failed" });
    const card = wait ? page.locator(".accept-gate-wait") : gateRow(page);
    const stop = wait ? "不等了，收掉它" : "停止";
    await card.waitFor();
    if (wait) await page.locator(".wait-bar__bar").click();
    await card.getByRole("button", { name: stop }).click();
    await notice(page).filter({ hasText: "取消结果保存失败" }).waitFor();
    assert.match(await notice(page).innerText(), /重试取消/);
    assert.doesNotMatch(await notice(page).innerText(), /已经结束|已取消这一次/);
    await card.getByRole("button", { name: stop }).waitFor();
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/cancel-settlement-failed-${wait ? "wait" : "card"}.png`, fullPage: true });
    await page.close();
  }
  // 本机能力不可用：红行、不转圈、不交给任务；出路是确认层里取消「运行」（这次跳过）。
  {
    const { page, store } = await open({ gate: { command: "npm test", running: null, latest: null,
      unavailable: "监督能力不可用，本机未执行；请换机或明确跳过" } });
    const row = gateRow(page);
    assert.equal(await stateOf(row), "本机能力不可用");
    await assertTone(row, "block");
    assert.equal(await row.locator(".acc-spin").count(), 0);
    assert.equal(store.handoffs, 0);
    const layer = await openConfirm(page);
    await layer.getByRole("checkbox", { name: "运行前置命令" }).uncheck();
    await layer.getByRole("button", { name: "跳过并验收", exact: true }).click();
    await waitUntil(() => store.accepts.length === 1, "跳过那一按发出去");
    assert.deepEqual(store.accepts, [{ confirmUnverified: false, commit: true, gate: "skip" }]);
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/supervision-unavailable.png`, fullPage: true });
    await page.close();
  }
  {
    const executionNotice = "macOS 兼容监督：不具备 cgroup/Job 的整次运行内核保证。独立测试快照保留，不自动删除。";
    for (const query of ["", "?stage=accepted", "?wait=1"]) {
      const current = run({ status: query === "?wait=1" ? "running" : "passed", executionNotice });
      const { page, store } = await open({ gate: { command: current.command, running: query === "?wait=1" ? current : null,
        latest: current, executionNotice, basis: query === "?stage=accepted" ? basis("passed", current) : null }, query });
      if (query === "?wait=1") {
        await page.getByRole("button", { name: /验收前置命令在跑/ }).click();
        await page.getByRole("note").filter({ hasText: executionNotice }).waitFor();
      } else {
        // 通过的那一次日志收着：点开这一行才看得到监督方式（只留名字，全文指上去看）。
        await gateRow(page).locator(".acc-check-main").click();
        const note = gateRow(page).locator(".acc-log-note");
        assert.equal(await note.innerText(), "macOS 兼容监督");
        assert.equal(await note.getAttribute("aria-label"), executionNotice);
      }
      assert.equal(store.handoffs, 0);
      assert.equal(await page.getByText("本机能力不可用").count(), 0);
      if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/macos-compatible-${query === "?wait=1" ? "running" : query ? "receipt" : "ready"}.png`, fullPage: true });
      await page.close();
    }
  }
  for (const wait of [false, true]) {
    const pending = run({ status: "failed", failure: "process_unconfirmed", processPending: true });
    const { page, store } = await open({ gate: { command: pending.command, running: pending, latest: pending }, query: wait ? "?wait=1" : "" });
    const card = wait ? page.locator(".accept-gate-wait") : gateRow(page);
    await card.waitFor();
    if (wait) {
      assert.match(await card.innerText(), /等待退出证据/);
      assert.equal(await card.locator(".is-spinning").count(), 0);
      await page.locator(".wait-bar__bar").click();
    } else {
      assert.equal(await stateOf(card), "进程还没退干净");
      assert.equal(await card.locator(".acc-spin").count(), 0);
    }
    await card.getByRole("button", { name: "停止证据丢失？确认风险并强制释放…" }).click();
    assert.equal(store.released ?? 0, 0, "展开风险说明不是确认释放");
    await card.getByRole("button", { name: "保留保护" }).click();
    assert.equal(store.released ?? 0, 0);
    await card.getByRole("button", { name: "停止证据丢失？确认风险并强制释放…" }).click();
    assert.match(await card.getByRole("alert").innerText(), /不等于停止或测试通过/);
    if (process.env.ASH_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.ASH_TEST_ARTIFACTS}/force-release-confirm-${wait ? "wait" : "card"}.png`, fullPage: true });
    await card.getByRole("button", { name: "我确认风险，强制释放本次占用" }).click();
    await notice(page).filter({ hasText: "没有取得退出证据" }).waitFor();
    assert.equal(store.released, 1);
    assert.equal(store.gate.latest.failure, "ownership_waived");
    await page.close();
  }
  {
    const timestamp = new Date().toISOString();
    const rows = [
      { id: "single", title: "普通任务（暂停）", mode: "single", status: "paused" },
      { id: "lead", title: "团队（执行者暂停）", mode: "team", status: "idle" },
      { id: "worker", title: "执行者（暂停）", mode: "single", status: "paused", parentId: "lead" },
    ].map(row => ({ projectId: "proj-1", updatedAt: timestamp, monitorRunning: false, ...row }));
    const { page, store } = await open({ query: "?dots=1", events: true, tasks: rows });
    const assertDots = async kind => {
      for (const row of rows) {
        // 侧栏那套记号的类名是 taskLook 的 mark（等你 = wait、会自己回来 = breathe），团队那套是档位名。
        const variant = row.mode === "team" ? kind : { attention: "wait", working: "breathe" }[kind];
        const dot = page.locator(`[data-task-id="${row.id}"] .${row.mode === "team" ? "team" : "workspace"}-status-dot--${variant}`);
        await dot.waitFor();
        assert.equal(await dot.evaluate(element => getComputedStyle(element).animationName), kind === "working" ? "task-status-dot-pulse" : "none");
      }
    };
    await assertDots("attention");
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/dots-paused.png` });
    store.tasks = rows.map(row => ({ ...row, monitorRunning: row.id !== "lead" }));
    await page.evaluate(() => window.emitGateEvent({ type: "task.monitors", taskId: "worker" }));
    await assertDots("working");
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/dots-monitor-running.png` });
    store.tasks = rows;
    await page.evaluate(() => window.emitGateEvent({ type: "task.monitors", taskId: "worker" }));
    await assertDots("attention");
    await page.reload();
    await assertDots("attention");
    await page.close();
  }
  // 命令一换，那份绿立刻不作数；命令一撤，这一行就不出了。
  {
    const previous = run();
    const { page, store } = await open({ events: true, gate: { command: previous.command, running: null, latest: previous } });
    await assertTone(gateRow(page), "passed");
    assert.match(await stateOf(gateRow(page)), /^通过 · /);
    store.gate = { command: "npm run replacement", running: null, latest: { ...previous, stale: true } };
    await page.evaluate(() => window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }));
    await gateRow(page).filter({ hasText: "npm run replacement" }).waitFor();
    assert.equal(await stateOf(gateRow(page)), "通过，但命令变了");
    if (process.env.ASH_BROWSER_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.ASH_BROWSER_EVIDENCE_DIR}/command-invalidated.png` });
    store.gate = { command: null, running: null, latest: previous };
    await page.evaluate(() => window.emitGateEvent({ type: "task.acceptGate", taskId: "gate-task" }));
    await gateRow(page).waitFor({ state: "detached" });
    await fetchesSettled(page, 0, "撤掉命令那一发已被页面消费完");
    await page.close();
  }
  await testAcceptGateReceipts({ open, run, basis });
  await testAcceptGateConfirm({ open, run });
  await testAcceptGateRecovery({ open, run, basis });
  await testAcceptGateActions({ open, run });
  console.log("accept gate desk DOM regression passed");
} finally {
  await browser?.close();
  await web.close();
}
