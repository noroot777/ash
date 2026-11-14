// 哨兵面板在真壳子里的两件事（第 1 轮审查逮到的 ② 和 ③）：
//
// ② 切任务的那一下。hook 挂在 InspectorHost 之外（跟 TaskDetail 一样，Host 自己按
//    contextKey 重挂、hook 不重挂），所以上一个任务在途的请求会原样回来盖在当前面板上
//    ——那张列表每行都带「停掉」按钮，点下去真停的是上一个任务的活。而 `stop`/`start`
//    收尾调的那发更隐蔽：它手里的 reload 是创建那一刻的闭包，带的是旧 taskId，比代号
//    比不出来（代号是它自己出门时取的），只能在出门前问一句「现在还是这个任务吗」。
//
// ③ 340px（Inspector 默认宽）下的布局。命令行和 cwd 都是不可断的长字符串，Grid 列不
//    写 `min-width: 0` 就会被内容顶宽，把「停掉」按钮挤出面板。**不能靠点一下按钮验证**
//    ——Playwright 点击会自动把元素滚进视野，挤出去了照样点得到。只认几何：按钮的盒子
//    必须落在面板里，面板不许出现横向滚动。
//
// **台子在隔壁**（`monitor-dom-harness.mjs`,全局约定:单文件不超过 700 行）:真 Vite、真
// Chromium、`page.route` 兜底那几条 API 都在那边，「它什么时候算完」那一格的用例在
// `test-monitor-composer-dom.mjs`。
import assert from "node:assert/strict";
import { monitor, openHarness } from "./monitor-dom-harness.mjs";
import { fetchLog, fetchesSettled, outlastPageTimers, settlePage, waitUntil } from "./wait-until.mjs";

const { open, idsOf, waitIds, failures, close } = await openHarness();

/**
 * 「`fragment` 那个地址上的读取已经回来、页面上也没有别的在途请求了」—— 负向断言前要的正向
 * 信号。先等它至少发出一发（切任务之后新任务那一发可能还没出门），再等页面上被记的请求全部
 * 被消费完（读完或被掐掉）并冲刷一轮。
 */
const landed = async (page, fragment, message) => {
  await waitUntil(async () => (await fetchLog(page)).some((entry) => entry.url.includes(fragment)), `${message}（等它发出）`);
  return fetchesSettled(page, 0, message);
};
/** 页面上发往 `fragment` 的 GET 有几发（页面这一侧数，桩那一侧会晚到）。 */
const getsTo = async (page, fragment) => (await fetchLog(page))
  .filter((entry) => entry.method === "GET" && new URL(entry.url, "http://page.invalid").pathname === fragment).length;
const pending = [];
try {
  // ── 「用过才浮现」落到图标条上：没挂过不上条、挂过角上带一颗点 ────────────────
  // 点是 CSS 的 `[data-dot]::before` 画的，属性两边一错位就悄悄没了，而「少一颗 5px 的点」
  // 这种事看快照、读代码都发现不了，只能量伪元素的计算样式。
  {
    // ① 这个任务一个哨兵都没挂过：不上图标条，但必须留在「+」菜单里——上一版的子智能体
    //    就是整格摘掉，结果用户翻遍菜单也找不到它。
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      await route.fulfill({ json: [] });
      return true;
    }, "?rail=1");
    await page.locator('.inspector-rail__tab[data-choice-value="info"]').waitFor();
    // 「不该上条」要在 task-a 那份（空）列表落地之后才说得算。
    await landed(page, "/api/tasks/task-a/monitors", "task-a 的哨兵列表已被页面读完");
    assert.equal(
      await page.locator('.inspector-rail__tab[data-choice-value="monitors"]').count(),
      0,
      "没挂过哨兵的任务，这一格不该占着图标条",
    );
    await page.getByRole("button", { name: "添加 Inspector 面板" }).click();
    assert.equal(
      await page.locator('.inspector-host__menu .inspector-host__menu-title', { hasText: "哨兵" }).count(),
      1,
      "没挂过也得留在「+」菜单里：手动起哨兵只有这一个入口",
    );
    const menuItem = (title) => page.locator(".inspector-host__menu .ui-menu-item", { hasText: title });
    assert.equal(await menuItem("信息").isDisabled(), true, "已在图标条上的面板，「+」菜单里要置灰");
    assert.equal(await menuItem("哨兵").isDisabled(), false, "没上条的面板在「+」菜单里照常可点");
    await page.close();
  }
  {
    // ② 挂过哨兵：自己冒到图标条上（不抢焦点），角上带一颗点；选中只有一种长相，不上底色。
    const page = await open(undefined, "?rail=1");
    const tab = page.locator('.inspector-rail__tab[data-choice-value="monitors"]');
    await tab.waitFor();
    assert.equal(
      await page.locator('.inspector-rail__tab[aria-selected="true"]').getAttribute("data-choice-value"),
      "info",
      "自己冒出来的那一格不许抢当前焦点",
    );
    const paint = await page.evaluate(() => {
      const tab = (id) => document.querySelector(`.inspector-rail__tab[data-choice-value="${id}"]`);
      const dot = (id) => getComputedStyle(tab(id), "::before");
      return {
        dot: tab("monitors").getAttribute("data-dot"),
        monitorsDot: { content: dot("monitors").content, width: dot("monitors").width },
        infoDot: dot("info").content,
        monitorsBg: getComputedStyle(tab("monitors")).backgroundColor,
        infoBg: getComputedStyle(tab("info")).backgroundColor,
      };
    });
    assert.ok(paint.dot === "has" || paint.dot === "run", `挂过哨兵的那一格要带 data-dot，现在是 ${paint.dot}`);
    assert.notEqual(paint.monitorsDot.content, "none", "角上那颗点要真的画出来");
    assert.equal(paint.monitorsDot.width, "5px", "点是 5px 的小圆点");
    assert.equal(paint.infoDot, "none", "没东西的格不画点");
    assert.equal(paint.monitorsBg, paint.infoBg, "用过的格不再上底色：状态只走那颗点");
    await page.close();
  }

  // ── 切任务那一帧的归属：图标条的显隐不许吃上一个任务的哨兵列表 ───────────────
  // `useMonitorInspector` 挂在 InspectorHost 之外，而 Host 自己按 contextKey 重挂。切任务
  // 时列表 state 只在 effect 里清空，于是**新 Host 的第一次渲染**读到的还是上一个任务的
  // 列表——它据此算出的 `defaultOpen` 会被 `defaultState` 写进 openTabs、被 `knownTabIds`
  // 记成「这一格出现过」，而那两样都没有撤销路径：本任务真实的应答回来也纠正不了。
  // 两个方向各错一次，都只在**跨任务**时出现，所以上面那些单任务用例一个都看不见。
  {
    // 方向一：上一个任务挂着哨兵 → 切到从没用过哨兵的任务，不该凭空多一格（还会被存下来）。
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-b/monitors") return false;
      await route.fulfill({ json: [] });
      return true;
    }, "?rail=1");
    await page.locator('.inspector-rail__tab[data-choice-value="monitors"]').waitFor();
    await page.getByRole("button", { name: "切换任务" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="task"]')?.textContent === "task-b");
    await landed(page, "/api/tasks/task-b/monitors", "task-b 的哨兵列表已被页面读完");
    assert.equal(
      await page.locator('.inspector-rail__tab[data-choice-value="monitors"]').count(),
      0,
      "切到从没挂过哨兵的任务，图标条不该留着上一个任务带来的那一格",
    );
    assert.doesNotMatch(
      String(await page.evaluate(() => window.localStorage.getItem("ash:inspector:task:task-b"))),
      /"monitors"/,
      "那一格还会被存进 openTabs：刷新之后它仍然在，错得更久",
    );
    await page.close();
  }
  {
    // 方向二：先看一个没哨兵的任务 → 去别处 → 它期间挂上了哨兵 → 切回来，必须自己冒出来。
    let aList = [];
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      await route.fulfill({ json: aList });
      return true;
    }, "?rail=1");
    await page.locator('.inspector-rail__tab[data-choice-value="info"]').waitFor();
    await landed(page, "/api/tasks/task-a/monitors", "task-a 的哨兵列表已被页面读完");
    assert.equal(
      await page.locator('.inspector-rail__tab[data-choice-value="monitors"]').count(),
      0,
      "前置条件：task-a 这会儿还没挂过哨兵",
    );

    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    aList = [monitor("m-task-a", "task-a")];
    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-a");

    const tab = page.locator('.inspector-rail__tab[data-choice-value="monitors"]');
    // 正向的事等它出现；下面几条连带的记号与焦点要在读取都落完、渲染冲刷之后再读。
    await tab.waitFor();
    await fetchesSettled(page, 0, "切回 task-a 之后的读取都已被页面读完");
    assert.equal(await tab.count(), 1, "切回来时它已经挂上哨兵了，这一格必须自己冒出来");
    assert.equal(await tab.getAttribute("data-dot"), "run", "那条还在跑：角上得是主色的活信号点");
    assert.equal(
      await page.locator('.inspector-rail__tab[aria-selected="true"]').getAttribute("data-choice-value"),
      "info",
      "自己冒出来仍然不许抢焦点",
    );
    await page.close();
  }

  // ── ③ 340px 下按钮不许被挤出面板 ───────────────────────────────────────────
  {
    const page = await open();
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitIds(page, "m-task-a");
    // 命令和输出都展开：那两段是整页里最长的不可断内容。
    await page.getByRole("button", { name: "命令", exact: true }).click();
    await page.getByRole("button", { name: "输出", exact: true }).click();
    await page.locator(".monitor-card__log pre").waitFor();

    const geometry = await page.evaluate(() => {
      const host = document.querySelector(".inspector-host");
      const content = document.querySelector(".inspector-host__content");
      const stop = document.querySelector(".monitor-card__stop");
      const card = document.querySelector(".monitor-card");
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      return {
        host: box(host),
        content: box(content),
        stop: box(stop),
        card: box(card),
        contentOverflow: content.scrollWidth - content.clientWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(Math.round(geometry.host.width), 340, "这一段测的就是默认宽度，不能靠加宽 Inspector 蒙过去");
    assert.ok(
      geometry.stop.right <= geometry.content.right + 0.5 && geometry.stop.left >= geometry.content.left - 0.5,
      `「停掉」按钮被挤出面板了：按钮 ${JSON.stringify(geometry.stop)}，面板 ${JSON.stringify(geometry.content)}`,
    );
    assert.ok(geometry.contentOverflow <= 1, `面板出现横向滚动（溢出 ${geometry.contentOverflow}px）`);
    assert.ok(geometry.cardOverflow <= 1, `卡片自己被内容顶宽了（溢出 ${geometry.cardOverflow}px）`);
    assert.ok(geometry.docOverflow <= 1, `整页被顶出横向滚动（溢出 ${geometry.docOverflow}px）`);
    assert.ok(geometry.card.width <= geometry.content.width + 0.5, "卡片不该比面板还宽");
    await page.close();
  }

  // ── ② 初次读取在途时切走：它回来不许盖到当前任务上 ─────────────────────────
  {
    let releaseA;
    const held = new Promise((resolve) => { releaseA = resolve; });
    pending.push(() => releaseA());
    let aCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      aCalls += 1;
      await held;
      await route.fulfill({ json: [monitor("m-task-a", "task-a")] }).catch(() => undefined);
      return true;
    });
    await waitUntil(() => aCalls >= 1, "任务 A 的读取出门并卡在桩上");

    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseA();
    // 被扣住的 A 那一发：要么切任务时已被掐掉，要么此刻才回来 —— 等它被页面消费完再看。
    await fetchesSettled(page, 0, "A 那发迟到的列表已被页面读完或掐掉");
    assert.equal(await idsOf(page), "m-task-b", "切走之后才回来的那发不许盖到当前任务的面板上");
    assert.match(await page.locator(".monitor-card b").innerText(), /task-b/);
    await page.close();
  }

  // ── ② 「停掉」的收尾那一发：闭包里带的是旧 taskId，出门前就得拦住 ───────────
  {
    let releaseStop;
    const held = new Promise((resolve) => { releaseStop = resolve; });
    pending.push(() => releaseStop());
    let stopCalls = 0;
    let aListCalls = 0;
    const page = await open(async (route, path) => {
      if (path === "/api/monitors/m-task-a/stop") {
        stopCalls += 1;
        await held;
        await route.fulfill({ json: { monitor: monitor("m-task-a", "task-a", { status: "stopped", endedAt: "2026-10-09T03:00:00.000Z" }) } }).catch(() => undefined);
        return true;
      }
      if (path === "/api/tasks/task-a/monitors") {
        aListCalls += 1;
        return false; // 走默认实现，只是数一下它被读了几次
      }
      return false;
    });
    await waitIds(page, "m-task-a");
    await page.getByRole("button", { name: /^停掉哨兵/ }).click();
    await waitUntil(() => stopCalls >= 1, "停止请求出门并卡在桩上");
    assert.equal(stopCalls, 1, "停止请求已经出门并卡住");

    const listedBefore = aListCalls;
    const pageListedBefore = await getsTo(page, "/api/tasks/task-a/monitors");
    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseStop();
    // 停止的回执被页面读完，收尾那一发 reload 若要出门此刻已经出门（页面侧记得到，等它也落完）。
    await fetchesSettled(page, 0, "停止的回执与它之后的读取都已被页面消费完");
    assert.equal(
      await getsTo(page, "/api/tasks/task-a/monitors"),
      pageListedBefore,
      "停止收尾的 reload 带的是旧 taskId：切走之后它一发都不该出门（页面这一侧）",
    );
    assert.equal(
      aListCalls,
      listedBefore,
      "停止收尾的 reload 带的是旧 taskId：切走之后它一发都不该出门（它的结果会直接写进当前面板）",
    );
    assert.equal(await idsOf(page), "m-task-b", "当前面板上还是当前任务的哨兵");
    await page.close();
  }

  // ── ② 停止失败的那句报错同理：说的是上一个任务的事，不往新面板上贴 ───────────
  {
    let releaseStop;
    const held = new Promise((resolve) => { releaseStop = resolve; });
    pending.push(() => releaseStop());
    let stopCalls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/monitors/m-task-a/stop") return false;
      stopCalls += 1;
      await held;
      await route.fulfill({ status: 500, json: { error: "上一个任务的停止失败了" } }).catch(() => undefined);
      return true;
    });
    await waitIds(page, "m-task-a");
    await page.getByRole("button", { name: /^停掉哨兵/ }).click();
    await waitUntil(() => stopCalls >= 1, "停止请求出门并卡在桩上");

    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    releaseStop();
    await fetchesSettled(page, 0, "那发 500 的停止回执已被页面读完");
    assert.equal(await page.getByTestId("error").textContent(), "", "切走之后才回来的失败不该贴在新任务的面板上");
    assert.equal(await page.locator(".monitor-inspector__error").count(), 0);
    await page.close();
  }

  // ── 同一个任务内：乱序回来的旧响应不许顶掉新的 ─────────────────────────────
  {
    let releaseFirst;
    const held = new Promise((resolve) => { releaseFirst = resolve; });
    pending.push(() => releaseFirst());
    let calls = 0;
    const page = await open(async (route, path) => {
      if (path !== "/api/tasks/task-a/monitors") return false;
      calls += 1;
      if (calls === 1) {
        await held;
        // 读得更早、落地更晚的那份：它看到的还是「3 条事件」。
        await route.fulfill({ json: [monitor("m-task-a", "task-a", { events: 3 })] }).catch(() => undefined);
        return true;
      }
      await route.fulfill({ json: [monitor("m-task-a", "task-a", { events: 11 })] });
      return true;
    });
    await waitUntil(() => calls >= 1, "第一发读取出门并卡在桩上");
    // 断线重连作废在途那一发、重读一遍，新的那份带回更新的计数。不能拿直播事件当这一发：
    // 追平层对它是合流（在途就记一笔，等那一发落地或到点再跑，见 lib/catchUp.ts），被卡住的
    // 要是真读取，新计数 15 秒内都不会来。以前用事件也能过，靠的是 StrictMode 开发态重挂把
    // 第一发作废了 —— 页面起得慢、那一发没来得及出门时（并行跑、冷编译）就露馅。
    await page.waitForFunction(() => window.__sources.some((item) => !item.closed));
    await page.evaluate(() => { for (const source of window.__sources) source.onerror?.({}); });
    // 断线那一下（connected=false 的提交和它的 cleanup：作废代次、掐断在途）先落地，再发 open。
    await settlePage(page);
    await page.evaluate(() => { for (const source of window.__sources) source.onopen?.({}); });
    // 事件数收在「命令」那一块里（hidden，仍在 DOM）：按挂载判，不按可见判。
    await page.locator(".monitor-card__facts").filter({ hasText: "11 条事件" }).waitFor({ state: "attached" });

    releaseFirst();
    // 先出门的那一发要么已被断线掐掉，要么此刻才回来：等它被页面消费完再看。
    await fetchesSettled(page, 0, "先出门、后落地的那份已被页面读完或掐掉");
    assert.match(
      await page.locator(".monitor-card__facts").first().textContent(),
      /11 条事件/,
      "先出门、后落地的那份读到的是旧计数，不许把已经写进去的新计数顶回去",
    );
    await page.close();
  }

  // ── 上一个任务的创建迟到成功，不许清掉当前任务刚填的草稿 ───────────────────
  // 「起成功了」唯一的用处是把表单收起来，而此刻屏幕上那张表单已经是**另一个任务**的、
  // 里面往往还有没提交的内容。忙碌标记同理：它锁的是这张表单的提交按钮。
  {
    let releaseStart;
    const held = new Promise((resolve) => { releaseStart = resolve; });
    pending.push(() => releaseStart());
    let startCalls = 0;
    const page = await open(async (route, path) => {
      if (route.request().method() !== "POST" || path !== "/api/tasks/task-a/monitors") return false;
      startCalls += 1;
      await held;
      await route.fulfill({ json: { monitor: monitor("m-task-a-2", "task-a") } }).catch(() => undefined);
      return true;
    });
    await waitIds(page, "m-task-a");

    // 在 A 上起一个，请求卡住。
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    await page.locator(".monitor-composer textarea").fill("printf 'A\\n'; sleep 300");
    await page.getByRole("button", { name: "起一个哨兵", exact: true }).click();
    await waitUntil(() => startCalls >= 1, "A 的创建请求出门并卡在桩上");
    assert.equal(startCalls, 1, "A 的创建请求已经出门并卡住");

    // 切到 B，在 B 上重新开表单、填一份草稿。
    await page.getByRole("button", { name: "切换任务" }).click();
    await waitIds(page, "m-task-b");
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    const draft = page.locator(".monitor-composer textarea");
    const text = String.raw`printf 'B_DRAFT\n'; sleep 300`;
    await draft.fill(text);
    assert.equal(
      await page.getByRole("button", { name: "起一个哨兵", exact: true }).isDisabled(),
      false,
      "B 的提交按钮不该被 A 那条在途创建按住——那把锁锁的是别人的表单",
    );

    releaseStart();
    await fetchesSettled(page, 0, "A 那发迟到的创建回执与它之后的读取都已被页面消费完");
    assert.equal(await page.locator(".monitor-composer").count(), 1, "当前任务的表单不该被上一个任务的成功回调收走");
    assert.equal(await draft.inputValue(), text, "没提交过的草稿一个字都不该丢");
    assert.equal(await idsOf(page), "m-task-b", "列表也还是当前任务的");
    await page.close();
  }

  // ── 首次列表还在路上，创建就失败了：那句报错必须当场露面，而且别被列表读完抹掉 ──
  // 列表的归属闸（ready）管的是「这个任务有没有哨兵」，**不该连报错一起管**：创建是用户
  // 刚刚按下去的动作，它的失败跟列表读没读完没有半点关系。把两件事绑在一起的后果是
  // 慢网下点「起一个哨兵」失败后一片安静（第 2 轮审查实测），而按钮已经解锁、草稿还在,
  // 用户只会以为自己没点到。
  {
    let releaseList;
    const held = new Promise((resolve) => { releaseList = resolve; });
    pending.push(() => releaseList());
    const page = await open(async (route, path) => {
      if (path === "/api/tasks/task-a/monitors" && route.request().method() === "POST") {
        await route.fulfill({ status: 500, json: { error: "回归注入：创建哨兵失败" } });
        return true;
      }
      if (path !== "/api/tasks/task-a/monitors") return false;
      await held;
      await route.fulfill({ json: [] }).catch(() => undefined);
      return true;
    });

    // 列表还卡着，先手动起一个——它会失败。
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    const draft = page.locator(".monitor-composer textarea");
    const text = "printf 'never runs'";
    await draft.fill(text);
    const submit = page.getByRole("button", { name: "起一个哨兵", exact: true });
    await submit.click();

    const alert = page.locator(".monitor-inspector__error");
    await alert.waitFor();
    assert.match(await alert.innerText(), /创建哨兵失败/, "创建失败就得当场说出来，别等列表读完");
    assert.equal(await submit.isDisabled(), false, "提交按钮已经解锁了：这会儿没提示等于什么都没发生");
    assert.equal(await draft.inputValue(), text, "失败不该把草稿冲掉");

    // 列表这才读完（而且是成功的空列表）：它不该把刚才那句报错抹掉。
    releaseList();
    await waitIds(page, "");
    await fetchesSettled(page, 0, "那份迟到的空列表已被页面读完");
    assert.equal(
      await page.locator(".monitor-inspector__error").count(),
      1,
      "列表读完了就把用户那次失败的回执抹掉，等于让它只闪一下",
    );
    await page.close();
  }

  // ── 同一个任务上取消重开：旧请求的回执不许动新那张表单 ─────────────────────
  // 在途期间点取消、重新打开填另一条命令，是同一个任务上的**两张**表单。只按任务判
  // （代号只在切任务时变）的话，旧请求回来会关掉用户刚填的那一张，忙碌标记还一直按着
  // 它的提交按钮。
  {
    let releaseStart;
    const held = new Promise((resolve) => { releaseStart = resolve; });
    pending.push(() => releaseStart());
    let startCalls = 0;
    const page = await open(async (route, path) => {
      if (route.request().method() !== "POST" || path !== "/api/tasks/task-a/monitors") return false;
      startCalls += 1;
      await held;
      await route.fulfill({ json: { monitor: monitor("m-task-a-2", "task-a") } }).catch(() => undefined);
      return true;
    });
    await waitIds(page, "m-task-a");

    // 第一张表单：提交后卡住。
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    await page.locator(".monitor-composer textarea").fill("sleep 300");
    await page.getByRole("button", { name: "起一个哨兵", exact: true }).click();
    await waitUntil(() => startCalls >= 1, "第一张表单的创建出门并卡在桩上");
    assert.equal(startCalls, 1, "第一张表单的创建已经出门并卡住");

    // 点取消、重新打开，填一份新草稿——同一个任务，但是另一张表单。
    await page.getByRole("button", { name: "取消" }).click();
    await page.locator(".monitor-composer").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "手动起一个哨兵" }).click();
    const draft = page.locator(".monitor-composer textarea");
    assert.equal(await draft.inputValue(), "", "重开就是一张新表单，不该继承上一张的内容");
    const text = String.raw`echo REOPENED_DRAFT; sleep 300`;
    await draft.fill(text);
    assert.equal(
      await page.getByRole("button", { name: "起一个哨兵", exact: true }).isDisabled(),
      false,
      "重开的这张表单不该被上一张在途的请求按住",
    );

    releaseStart();
    await fetchesSettled(page, 0, "旧表单那发迟到的创建回执与它之后的读取都已被页面消费完");
    assert.equal(await page.locator(".monitor-composer").count(), 1, "旧请求的成功回执不该关掉新这张表单");
    assert.equal(await draft.inputValue(), text, "没提交过的草稿一个字都不该丢");
    await page.close();
  }

  // ── 断线重连之后必须重新对账：事件流没有历史回放 ───────────────────────────
  // 断线期间起的哨兵、结束的哨兵，服务端一条都不会补发（SSE 只订阅当前
  // bus、不带事件 id）。所以「又连上了」不能当成「这份快照还完整」——上一版把
  // useServerEvents 返回的连接状态整个丢掉，页面停在旧列表上，手动刷新才对得上
  // （第 11 轮审查用真实 EventSource 自动重连实测：open 次数增加、请求数一条没多）。
  {
    let listCalls = 0;
    const rows = [["m-task-a", "task-a"]];
    const page = await open(async (route, path) => {
      if (path === "/api/tasks/task-a/monitors" && route.request().method() === "GET") {
        listCalls += 1;
        await route.fulfill({ json: rows.map(([id, task]) => monitor(id, task)) });
        return true;
      }
      return false;
    });
    await waitIds(page, "m-task-a");
    // 首次连上的那次对账要先走完，下面记的「之前」才不会把它算成重连那一发：等桩替页面
    // 发过 open，冲刷掉 connected=true 的提交，再越过对账发车用的那个零延迟定时器
    // （useCatchUpLink），最后等它读完。
    await page.waitForFunction(() => window.__sources.some((source) => source.opened));
    await settlePage(page);
    await outlastPageTimers(page, 1);
    await fetchesSettled(page, 0, "首次连上的对账读取已被页面读完");
    const before = { listCalls };

    // 断线期间服务端那边又起了一条（页面收不到任何事件）。
    rows.push(["m-task-a-late", "task-a"]);
    // 页面里此前排上、150ms 内到期的定时器都走过一次；它们若发了读取也得落完。
    await outlastPageTimers(page, 150);
    await fetchesSettled(page, 0, "页面上没有在途的读取");
    assert.equal(await idsOf(page), "m-task-a", "没有事件、没有重连，页面当然还是旧列表");

    // 原生 EventSource 的重连就是在同一个对象上再发一次 open（中间先 error）。两步分开发：
    // 真实断线之间隔着秒级，而同一个 task 里 false→true 会被 React 合批成「没变过」。
    await page.evaluate(() => { for (const source of window.__sources) source.onerror?.({}); });
    // connected=false 的提交与它的 cleanup 先落地（React 把它排在 MessageChannel 上），再发 open。
    await settlePage(page);
    await page.evaluate(() => { for (const source of window.__sources) source.onopen?.({}); });
    await waitIds(page, "m-task-a,m-task-a-late");
    assert.ok(
      listCalls > before.listCalls,
      `重连后要把列表重读一遍（${before.listCalls}→${listCalls}）`,
    );
    await page.close();
  }

  // ── 会话最后那一行「在等哨兵」展开之后说了什么 ───────────────────────────────
  // 这件事**只能点开才看得见**：正文默认不渲染，所以静态渲染根本摸不到那段文案（第 21 轮
  // 审查 N2：上一版那条静态断言查的是折叠态，于是「不含某句话」在任何实现下都成立）。
  //
  // **判据按当前的监督事实写，不按 pid 空不空推断**（第 22 轮审查 N1）：接回层现在给每条
  // 运行行都先立 tail 和期限，跟认不认得回号无关，所以「有事件会把这条会话重新叫醒」对
  // 没认回来的那几条**也是真的**；同一段里一句「日志还没人接着读」、紧接着照抄的原因里
  // 又写着「日志和期限已经有人接着管」，那是两句话打架（页面实测逮到的就是这一处）。
  // 认不回号真正影响的是另一件事：点停未必停得掉那个进程 —— 那一句才是它该说的。
  {
    const bodyOf = async (mode) => {
      const page = await open(undefined, `?wait=${mode}`);
      await page.locator(".monitor-wait-line__bar").click();
      const body = page.locator(".monitor-wait-line__body");
      await body.waitFor();
      const text = await body.innerText();
      await page.close();
      return text;
    };

    const claimed = await bodyOf("claimed");
    assert.match(claimed, /重新叫醒/, "认回来的哨兵照旧：有事件会把这条会话重新叫醒");
    assert.match(claimed, /继续：接着做 tts 这一段/, "交代原文要照抄进正文");
    assert.doesNotMatch(claimed, /认不回它的进程/, "反向台子：正常那条一个字都不该提「认不回」");

    const pending = await bodyOf("pending");
    assert.match(pending, /重新叫醒/,
      "没认回来的那条也会被叫醒（tail 和期限在 pending 那一刻就接上了）——收回这句话才是撒谎");
    assert.match(pending, /这一刻认不回它的进程/, "得说清它现在是什么处境");
    assert.match(pending, /未必停得掉那个进程/, "认不回号真正影响的那一件事要说出来：点停未必停得掉它");
    assert.match(pending, /日志和期限已经有人接着管/, "受阻原因照抄：用户据以决定等不等的就是这一句");
    assert.doesNotMatch(pending, /还没人接着读|没人读/,
      "**同一段里不许同时说「日志没人读」和「日志有人管」**（第 22 轮审查 N1 页面实测）");
  }

  assert.deepEqual(failures, []);
  console.log("monitor inspector dom: stop button stays inside the 340px panel, stale task/form results never land, reconnects re-read the snapshot, the expanded wait card describes the real supervision state (woken either way; unclaimed ones may not be stoppable)");
} finally {
  pending.forEach((release) => release());
  await close();
}
