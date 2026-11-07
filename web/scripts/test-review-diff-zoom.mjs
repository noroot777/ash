import assert from "node:assert/strict";
import { launchChrome, startWebServer } from "./dom-stage.mjs";

const web = await startWebServer();

let browser;
try {
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${web.origin}/scripts/fixtures/review-diff-zoom.html`);

  const zoomLayer = page.locator(".zoom-layer");
  const zoomButton = page.locator("#fixture-main .single-review-zoom");
  // 真的 `InspectorHost`，不是手搓的常驻壳：面板关光时整条会从 DOM 里消失（见 fixture 头注）。
  const inspector = page.locator(".inspector-host");
  const dock = page.locator("#fixture-dock");
  await zoomButton.waitFor();
  assert.equal(await zoomLayer.count(), 0, "默认不该是放大状态");

  const geometry = async () => {
    const box = await zoomLayer.boundingBox();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  };

  // 「让位跟对了」的判据，每一处几何断言都先过这一关：右缘顶住 inspector 的左缘（一条都
  // 没有时顶住窗口右缘，也就是铺满），下缘顶住工作区那一行的下缘（底部坞在那条线之下）。
  // 两轴都是观察器 → setState → 重渲染，尺寸刚变完的那一帧层还落后一拍，不等它追上就读
  // 具体数值，拖一下就偶发。
  const alignment = () => page.evaluate(() => {
    const layer = document.querySelector(".zoom-layer")?.getBoundingClientRect();
    if (!layer) return null;
    const host = document.querySelector(".inspector-host")?.getBoundingClientRect();
    const row = document.querySelector(".workspace-system-layout > .workspace-shell").getBoundingClientRect();
    return {
      right: Math.round(layer.right),
      wantRight: Math.round(host ? host.left : window.innerWidth),
      bottom: Math.round(layer.bottom),
      wantBottom: Math.round(row.bottom),
    };
  });
  const settle = async (what) => {
    try {
      await page.waitForFunction(() => {
        const layer = document.querySelector(".zoom-layer")?.getBoundingClientRect();
        if (!layer) return false;
        const host = document.querySelector(".inspector-host")?.getBoundingClientRect();
        const row = document.querySelector(".workspace-system-layout > .workspace-shell").getBoundingClientRect();
        return Math.round(layer.right) === Math.round(host ? host.left : window.innerWidth)
          && Math.round(layer.bottom) === Math.round(row.bottom);
      });
    } catch {
      assert.fail(`${what}：放大层没有贴上该让的位，实测 ${JSON.stringify(await alignment())}`);
    }
  };

  // 真实拖拽宽度把手，而不是直接改 `--inspector-width`：要钉的是「观察器确实绑在**当前
  // 那条** inspector 上」，手动改变量只验证了 CSS 还活着。
  const dragInspectorWider = async (by) => {
    const before = (await inspector.boundingBox()).width;
    const hb = await page.locator(".inspector-host__resize-handle").boundingBox();
    // 把手是 `left:-3px; width:6px`，正中就是 inspector 的左缘——那一像素归谁不一定，放大层
    // 的右缘正压在那儿。按在偏内侧 1.5px 处才确定落在 inspector 身上。拖动和松手走的是
    // window 上的监听，落点压在放大层上也收得到。
    const x = hb.x + hb.width - 1.5;
    const y = hb.y + hb.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - by, y, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(
      (expected) => Math.abs(document.querySelector(".inspector-host").getBoundingClientRect().width - expected) < 1.5,
      before + by,
    );
  };

  await zoomButton.click();
  await zoomLayer.waitFor();
  await settle("刚进放大态");

  // 铺满窗口，但右边让开 inspector 那一列、底下让开横贯窗口的坞（终端 + 全局状态栏）：
  // 放大是把 diff 铺开来看，旁边的审查记录得留着，状态栏上的项目和终端开关也还要点得到。
  // fixture 抄了 `.workspace-shell` 右边那 8px 内边距，inspector 因此差一点没贴到窗口右缘——
  // 让位的判据必须容得下这一点，否则真实页面里一条 inspector 都找不到（放大又会盖回去）。
  const viewport = page.viewportSize();
  const inspectorBox = await inspector.boundingBox();
  const dockBox = await dock.boundingBox();
  assert.ok(
    viewport.width - (inspectorBox.x + inspectorBox.width) >= 8,
    "fixture 该保留右侧内边距，inspector 不能正好贴死窗口右缘",
  );
  assert.deepEqual(
    await geometry(),
    { x: 0, y: 0, width: Math.round(inspectorBox.x), height: Math.round(dockBox.y) },
    "放大层该占满 inspector 左边、底部坞上边的那整块窗口",
  );

  // 左边的任务栏必须被盖住。主区自成堆叠上下文，留在原地的层无论 z-index 多大都盖不住它，
  // 所以这一条钉住「portal 到 body」这个实现前提。
  const rail = await page.locator("#fixture-rail").boundingBox();
  const overRail = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".zoom-layer"),
    [rail.x + rail.width / 2, rail.y + rail.height / 2],
  );
  assert.ok(overRail, "放大层该压住左边的任务栏，而不是被主区的堆叠上下文困住");

  // inspector 和底部坞反过来必须点得到：它们一个在主区那个堆叠上下文里、一个在工作区那一
  // 行外面，portal 之后单靠 z-index 一定会被盖掉，只能靠让出宽高。
  const overInspector = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".inspector-host"),
    [inspectorBox.x + inspectorBox.width / 2, inspectorBox.y + 20],
  );
  assert.ok(overInspector, "inspector 不该被放大层盖住");
  const overDock = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest("#fixture-dock"),
    [40, dockBox.y + dockBox.height / 2],
  );
  assert.ok(overDock, "底部坞不该被放大层盖住");

  // 拖宽 inspector，放大层跟着让位（ResizeObserver）。
  await dragInspectorWider(80);
  await settle("拖宽 inspector 后");
  assert.equal((await geometry()).width, Math.round(inspectorBox.x) - 80, "拖宽 inspector 后放大层该跟着让位");

  // ── 面板被一个个关掉 ────────────────────────────────────────────────────────────
  // 关第一个，还剩一个：整条 inspector 还在，继续让位。
  await inspector.getByRole("button", { name: "关闭审查记录" }).click();
  await inspector.getByText("这一轮改了两个文件。").waitFor();
  assert.equal(await inspector.count(), 1, "还剩一个面板时 inspector 不该整条消失");
  await settle("关掉第一个面板后");

  // 关最后一个：inspector 整条卸载，放大层该**铺满**可用宽度。
  // 旧实现在进放大态时就把 host 节点捕获进闭包，节点卸载后 `getBoundingClientRect()` 全是
  // 0 —— left 读成 0，右缘被算成整个视口宽，层当场挤成左缘一条细条（只剩 padding，实测
  // width=25，文字被挤成一字一行的竖排）。下缘必须同时保持让开底部坞，不能跟着一起退化。
  await inspector.getByRole("button", { name: "关闭改动与提交" }).click();
  await inspector.waitFor({ state: "detached" });
  await settle("关光所有面板后");
  assert.deepEqual(
    await geometry(),
    { x: 0, y: 0, width: viewport.width, height: Math.round(dockBox.y) },
    "没有 inspector 时放大层该铺满可用宽度，下缘仍让开底部坞",
  );

  // 重开面板（从底部坞那颗按钮——放大层让开的正是那一条，真实页面上的全局状态栏同理）：
  // inspector 回来，层重新让位；**再拖一次宽还得跟上**，这一条才证明观察器重绑到了新那条
  // inspector 上，而不是只剩「关掉那一瞬」那一发回调。
  await dock.getByRole("button", { name: "重开审查记录" }).click();
  await inspector.waitFor();
  await settle("重开面板后");
  const reopened = (await geometry()).width;
  await dragInspectorWider(60);
  await settle("重开面板再拖宽后");
  assert.equal(
    (await geometry()).width,
    reopened - 60,
    "重开面板后拖宽 inspector，放大层没跟上——观察器没有重绑到新那条",
  );

  // 拖高底部坞（拉高终端同理）：下缘跟着上移。接在「关面板 → 重开面板」后面，钉的是这一
  // 串连续动作走完之后两轴仍各自跟对，而不是只在刚进放大态时对一次。
  await dock.evaluate((node) => { node.style.height = "160px"; });
  await settle("拖高底部坞后");
  assert.equal((await geometry()).height, Math.round((await dock.boundingBox()).y), "拖高底部坞后放大层下缘该跟着上移");
  await dock.evaluate((node) => { node.style.height = "36px"; });
  await settle("底部坞收回后");

  // 在 inspector 里点验收：放大态下这是真点得到的「外面」，不能把放大收掉；弹出来的确认框
  // 又必须压在放大层上面。
  await inspector.getByRole("button", { name: "验收通过" }).click();
  const dialog = page.locator(".task-confirm-dialog");
  await dialog.waitFor();
  assert.equal(await zoomLayer.count(), 1, "点 inspector 不该把放大层关掉");
  const dialogBox = await dialog.boundingBox();
  const topmost = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest(".task-confirm-dialog, .zoom-layer")?.className ?? "",
    [dialogBox.x + dialogBox.width / 2, dialogBox.y + 12],
  );
  assert.ok(topmost.includes("task-confirm-dialog"), `后开的确认框该在放大层上面，实测 ${topmost}`);

  // 点确认框自己身上：它 portal 到 body 之后 DOM 上不在放大层里，不登记进那一摞层就会
  // 被读成「点了外面」，连人带放大层一起关掉。
  await dialog.locator("h2").click();
  assert.equal(await dialog.count(), 1, "点确认框自己不该把它关掉");
  assert.equal(await zoomLayer.count(), 1, "点确认框不该被放大层读成「点了外面」");

  // Esc 一次只退一层：先关确认框，放大层留着。
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(await zoomLayer.count(), 1, "Esc 关确认框时放大层该留着");

  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });
  assert.equal(
    await page.locator("#fixture-main .single-review-diff-layout").count(),
    1,
    "退出放大后 diff 该回到原位",
  );

  // 也能用按钮退出：只按 Esc 的用户和只用鼠标的用户都得有出口。
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.locator(".single-review-zoom").click();
  await zoomLayer.waitFor({ state: "detached" });

  // 单栏 / 并排是「我习惯怎么读 diff」而不是某一块 diff 的属性。先从主区切（抽屉还没开，
  // 标题栏点得到），放大之后也还是并排。
  await page.locator("#fixture-main").getByRole("button", { name: "并排对比（左右分栏）" }).click();
  await page.locator("#fixture-main .single-review-code.is-split").waitFor();
  await zoomButton.click();
  await zoomLayer.waitFor();
  await zoomLayer.locator(".single-review-code.is-split").waitFor();
  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });

  // 长在执行者抽屉（z-index 95）里的那份 diff：放大层得抬到抽屉上面，否则按钮看着像坏了；
  // 让开的仍是窗口右缘那条 inspector，而不是抽屉里嵌的那条。
  await dock.getByRole("button", { name: "打开执行者抽屉" }).click();
  const drawer = page.locator("#fixture-drawer");
  await drawer.waitFor();
  // 抽屉是 260ms 滑入，等它停下来再按位置点东西。
  await page.waitForFunction(
    () => document.querySelector("#fixture-drawer").getAnimations().every((animation) => animation.playState === "finished"),
  );
  // 后开的这一份也是并排：那是一份跨表面共用的阅读偏好，不是某块 diff 自己的状态。
  await drawer.locator(".single-review-code.is-split").waitFor();

  await drawer.locator(".single-review-zoom").click();
  await zoomLayer.waitFor();
  await settle("抽屉里放大");
  const drawerZoom = await zoomLayer.evaluate((node) => ({
    z: Number(window.getComputedStyle(node).zIndex),
    width: Math.round(node.getBoundingClientRect().width),
  }));
  assert.ok(drawerZoom.z > 95, `抽屉里放大该抬到抽屉之上，实测 z-index ${drawerZoom.z}`);
  assert.equal(
    drawerZoom.width,
    Math.round((await inspector.boundingBox()).x),
    "抽屉里放大让开的仍该是窗口右缘那条 inspector",
  );
  const overDrawer = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".zoom-layer"),
    [240, 400],
  );
  assert.ok(overDrawer, "放大层该压住抽屉本身");
  await page.keyboard.press("Escape");
  await zoomLayer.waitFor({ state: "detached" });

  // 从抽屉里切回单栏，主区那份跟着变：偏好是实时共用的，不只是挂载时读一次。
  await drawer.getByRole("button", { name: "单栏对比（统一视图）" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".single-review-code.is-split").length === 0);

  console.log("review diff zoom test passed");
} finally {
  await browser?.close();
  await web.close();
}
