// wait-until.mjs 之外，这一批 DOM 回归还要用的两样正向信号（候选：提升进 wait-until.mjs）。
//
//   · `trackStubbedFetches` —— 夹具在页面里自己把 `window.fetch` 换成假服务端的那一类。共享的
//     `trackFetches` 包的是它换之前那一份，应用的请求根本不经过它；这里把「给 window.fetch
//     赋值」截下来，套一层同样的记账再交出去，记进同一个 `window.__ashFetches`，于是
//     `fetchLog` / `fetchesSettled` 照用。
//   · `afterFrames` —— 改了视口/尺寸之后「布局与它引起的重算都落地了」：resize 事件和
//     ResizeObserver 回调都在渲染那一步里派发，走过两帧，它们触发的 React 提交也已经排上，
//     再 `settlePage` 冲刷掉。跟负载无关：慢只会让帧来得晚，不会让回调跳过。
import { settlePage } from "./wait-until.mjs";

/**
 * 记下 URL 匹配 `pattern`（正则源码字符串）的每一发 fetch，哪怕页面里的夹具之后才把
 * `window.fetch` 换成自己的假服务端。必须在 `goto` 之前调用。`target` 可以是 page，也可以是
 * BrowserContext —— 后者对这个 context 里之后打开的每一页（含 `window.open` 出来的）都生效，
 * 读的时候照样按页 `fetchLog(page)`。
 */
export async function trackStubbedFetches(target, pattern) {
  await target.addInitScript((source) => {
    const matcher = new RegExp(source);
    const log = (window.__ashFetches ??= []);
    const tracked = (impl) => (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!matcher.test(url)) return impl(input, init);
      const entry = { url, method: init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"), state: "pending" };
      log.push(entry);
      const settle = (outcome) => { entry.state = "settled"; entry.outcome = outcome; };
      // 假服务端是同步算好这一刻的答复再返回的，所以这条记录一出现，它要答什么就已经定了。
      return new Promise((resolve) => resolve(impl(input, init))).then((response) => {
        if (response.body === null) settle(response.ok ? "ok" : `http ${response.status}`);
        for (const name of ["text", "json", "arrayBuffer", "blob"]) {
          const read = response[name].bind(response);
          response[name] = () => read().then(
            (value) => { settle(response.ok ? "ok" : `http ${response.status}`); return value; },
            (error) => { settle("aborted"); throw error; },
          );
        }
        return response;
      }, (error) => { settle("aborted"); throw error; });
    };
    let current = tracked(window.fetch.bind(window));
    Object.defineProperty(window, "fetch", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (impl) => { current = tracked(impl); },
    });
  }, pattern);
}

/** 走过 `count` 个渲染帧再冲刷一轮（页面须在前台：后台页的 rAF 会被节流）。 */
export async function afterFrames(page, count = 2) {
  await page.evaluate((frames) => new Promise((resolve) => {
    const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(frames);
  }), count);
  await settlePage(page);
}
