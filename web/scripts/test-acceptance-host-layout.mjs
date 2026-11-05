import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { launchChrome } from "./dom-stage.mjs";

// 验收动作宿主(.acceptance-host)的几何。钉的是一条契约,不是某一张卡的特例:
//
// ① **标题永远读得出来**。验收受阻时整句理由会被填进主按钮当标签(现场那句 30 个字),
//    状态文案长度没有上限;标题块必须有一道地板宽,宽到放不下就让动作簇换行,而不是把
//    标题压到只剩内边距。2026-11-02(任务 9tdMZpxobLQT)现场就是标题块 flex-basis 为 0
//    被压穿,「改动与提交」五个字逐字竖排,整条顶栏撑到几百像素高。
// ② **第一行之外的成员一律自己占满一整行**,而且这是**默认**不是白名单。测试里特意挂了
//    一个没有 class 的裸 <p>(真实的 AutoCommitOutcomeNotice 就长这样):白名单那套做法
//    对它无能为力,所以这一条专测「没被点过名的成员也照样守规矩」。
// ③ 四处宿主同一副形状:普通任务顶栏、团队顶栏、团队里每个独立执行者那张记录卡的 header、
//    讨论结论那条横条。修一处漏三处是这类毛病反复回来的原因;记录卡那处的标题块前面还站着
//    展开钮和状态点,所以标题认显式标记而不是「第一个孩子」。
// ④ 窄视口下地板不许反过来把自己顶出去(min() 退回 100%),以及 duet 在 600px 以下
//    改竖排时 ② 仍然成立(纵向主轴下 flex-basis:100% 会变成高度,所以契约写的是 min-width)。
const root = fileURLToPath(new URL("..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });

const BLOCK = "验收前置命令尚未确认整棵进程树退出，工作区仍被占用；暂不能合并或清理。";

/** 把一处宿主的几何量出来：标题块、以及每个子元素占没占满一行 / 有没有漏到框外。 */
const probe = () => [...document.querySelectorAll("[data-host]")].map((section) => {
  const host = section.querySelector(".acceptance-host");
  const style = getComputedStyle(host);
  const hostRect = host.getBoundingClientRect();
  // 内容宽要同时让开边框和内边距（duet 那处宿主两样都有）。
  const padRight = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
  const inner = hostRect.width - parseFloat(style.paddingLeft) - parseFloat(style.borderLeftWidth) - padRight;
  // 标题块认显式标记：记录卡那处宿主的标题前面还站着展开钮和状态点，不是第一个孩子。
  const title = host.querySelector(":scope > .acceptance-host-title");
  const heading = title.querySelector("b");
  return {
    host: section.dataset.host,
    column: style.flexDirection === "column",
    inner,
    titleWidth: title.getBoundingClientRect().width,
    titleHeight: title.getBoundingClientRect().height,
    headingHeight: heading.getBoundingClientRect().height,
    headingText: heading.textContent,
    overflow: hostRect.width - (host.scrollWidth || 0),
    children: [...host.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return {
        title: child === title,
        tag: child.tagName.toLowerCase(),
        className: typeof child.className === "string" ? child.className : "",
        width: rect.width,
        bled: Math.round(rect.right - (hostRect.right - padRight)),
        text: (child.textContent ?? "").slice(0, 24),
      };
    }),
  };
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address === "object", "Vite test server did not expose a port");
  const fixture = `http://127.0.0.1:${address.port}/scripts/fixtures/acceptance-host-layout.html`;
  browser = await launchChrome();

  // 880px 是现场那一屏的中栏宽度：标题块在修复前被压到 56px、折成 128px 高的竖排，
  // 恰好是「地板」那条断言唯一会红的宽度档。560px 则是 duet 改竖排的那一档。
  for (const width of [1280, 880, 760, 560]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(fixture);
    // 三处宿主都把那句长理由顶在主按钮上了，再量几何；否则量到的是一个还没受阻的空壳。
    await assert.doesNotReject(page.getByRole("button", { name: BLOCK }).first().waitFor());
    assert.equal(await page.getByRole("button", { name: BLOCK }).count(), 4, `${width}px：四处宿主都该摆上受阻按钮`);

    for (const row of await page.evaluate(probe)) {
      const where = `${row.host}@${width}px`;
      // ① 标题读得出来：有地板宽，且标题本身没被挤成竖排（一行标题 + 至多两行说明）。
      const floor = Math.min(row.inner, 240);
      assert.ok(row.titleWidth >= floor - 1, `${where}：标题块被压到 ${Math.round(row.titleWidth)}px，低于地板 ${Math.round(floor)}px`);
      assert.ok(row.headingHeight <= 30, `${where}：标题「${row.headingText}」占了 ${Math.round(row.headingHeight)}px，已经折成多行`);
      assert.ok(row.titleHeight <= 80, `${where}：标题块高 ${Math.round(row.titleHeight)}px，整行被撑爆`);

      for (const child of row.children) {
        const label = `${where} · ${child.tag}${child.className ? `.${child.className.split(/\s+/).join(".")}` : ""}`;
        // ④ 谁都不许漏到宿主的内边距线外。
        assert.ok(child.bled <= 1, `${label}：越过宿主右边界 ${child.bled}px（${child.text}）`);
        // ② 第一行只留标题块和动作簇；其余成员——包括这个没有 class 的 <p>——自己占满一整行。
        const firstRow = child.title || ["button", "a", "span", "i"].includes(child.tag)
          || child.className.includes("team-accept-actions");
        if (firstRow && !row.column) continue;
        assert.ok(child.width >= row.inner - 1,
          `${label}：只占 ${Math.round(child.width)}px / ${Math.round(row.inner)}px，没有独占一行（${child.text}）`);
      }
    }
    assert.deepEqual(errors, [], `${width}px 渲染报错`);
    await page.close();
  }
  console.log("acceptance host layout: title floor, full-row default for unclassed members, four hosts, 1280/880/760/560px passed");
} finally {
  await browser?.close();
  await server.close();
}
