// DOM 回归里「等一件异步的事成立」的共用写法。
//
// 为什么不用 `page.waitForTimeout(固定毫秒)` 再断言：门禁把两百多条叶子按 8 路并行跑
// （scripts/test-runner.mjs），一条在空闲机器上 300ms 就落地的响应，在满载时可以晚到好几秒。
// 固定睡眠等于赌「这么久应该够了」，赌输的那一次就是一条与改动无关的闪红（2026-11-06
// 验收台 ⑰：睡 1.8 秒，那时连第二次响应都还没落地）。所以这里只提供「等到某件事**成立**」：
//
//   · `waitUntil`   —— 正向条件：轮询到它成真为止，期限按负载给足，超时说清在等什么。
//   · `trackFetches` + `fetchesSettled` —— 页面侧记下每一发请求有没有**被页面消费完**
//     （响应体读完，或者被 abort）。Node 侧的路由桩只知道「我送出去了」，不知道页面处理没有。
//   · `outlastPageTimers` —— 「过一阵也不该变」：等页面里一个更晚到期的定时器触发，证明
//     此前排上的心跳/重试都已经走过一次（定时器按到期先后触发，跟负载无关）。
//   · `settlePage`  —— 负向断言（「X 不该出现」）之前的最后一步：先用上面两样等到能证明
//     竞争已经结束的正向信号，再用它把页面里**已经排上队**的任务（React 的提交、effect）
//     冲刷掉，然后才读 DOM。它本身不等任何还没发生的事，所以不能单独拿来代替正向信号。
//
// Playwright 自带的 locator.waitFor / page.waitForFunction 能表达的就直接用它们；这里补的
// 是它们看不到的那几类（Node 侧桩的计数、页面里请求的结算）。

/** 条件等待的默认期限：满载（8～16 路并行）下也够，又不至于让真坏掉的用例干等半分钟。 */
export const WAIT_TIMEOUT_MS = 15_000;

/**
 * 轮询 `check` 直到它返回真值，返回那个值。`check` 可以是 async，抛错按「还没成立」算
 * （超时信息里会带上最后一次的错）。第二个参数可以直接写成说明字符串。
 */
export async function waitUntil(check, options = {}) {
  const { timeout = WAIT_TIMEOUT_MS, interval = 25, message = "条件成立" } =
    typeof options === "string" ? { message: options } : options;
  const deadline = Date.now() + timeout;
  let lastError;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  const tail = lastError ? `（最后一次检查抛错：${lastError instanceof Error ? lastError.message : lastError}）` : "";
  throw new Error(`等了 ${timeout}ms 仍未成立：${message}${tail}`);
}

/**
 * 在页面上记下 URL 匹配 `pattern`（正则源码字符串）的每一发 fetch：发出时记一条 pending，
 * 响应体被读完或请求失败/被 abort 时改成 settled。必须在 `page.goto` 之前调用。
 *
 * 「响应体读完」那一刻应用自己的后续（setState 之类）在同一个微任务检查点里跑完，所以
 * 读到 settled 之后再 `settlePage` 一次，页面就已经把这发响应处理干净了。
 */
export async function trackFetches(page, pattern) {
  await page.addInitScript((source) => {
    const matcher = new RegExp(source);
    const log = (window.__ashFetches ??= []);
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!matcher.test(url)) return original(input, init);
      const entry = { url, method: init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET"), state: "pending" };
      log.push(entry);
      const settle = (outcome) => { entry.state = "settled"; entry.outcome = outcome; };
      return original(input, init).then((response) => {
        // 204 之类没有响应体的，应用不会去读它：拿到响应头就算消费完。
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
  }, pattern);
}

/** `trackFetches` 记下的那几发（按发出顺序）：`[{ url, method, state, outcome }]`。 */
export function fetchLog(page) {
  return page.evaluate(() => (window.__ashFetches ?? []).map((entry) => ({ ...entry })));
}

/**
 * 等到页面上没有在途的被记请求：至少已记下 `count` 发，且每一发都被消费完（读完或 abort）。
 * 看到「全都结算了」之后还会 `settlePage` 一轮再看一次 —— 有的结算会在同一个回调里接着发
 * 下一发（追平层补欠账），那一发冲刷之后才看得见。返回日志。
 */
export function fetchesSettled(page, count = 0, message = `页面上被记的请求（至少 ${count} 发）都已消费完`) {
  const quiet = (log) => log.length >= count && log.every((entry) => entry.state === "settled");
  return waitUntil(async () => {
    const before = await fetchLog(page);
    if (!quiet(before)) return false;
    await settlePage(page);
    const after = await fetchLog(page);
    return after.length === before.length && quiet(after) && after;
  }, message);
}

/**
 * 把页面里**已经排上队**的工作冲刷掉：React 的调度器走 MessageChannel，同一任务源先进先出，
 * 所以排在它后面的几轮 MessageChannel 跑完时，此前已排上的提交与 effect（以及 effect 里
 * 再排的那一轮）都已落地。只用 MessageChannel：rAF 在后台页上会被节流，setTimeout 在装了
 * `page.clock` 的页面上是假的、不推时钟永远不会到。
 */
export async function settlePage(page, rounds = 4) {
  await page.evaluate(async (count) => {
    for (let i = 0; i < count; i += 1) {
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
        channel.port2.postMessage(null);
      });
    }
  }, rounds);
}

/**
 * 「等一会儿也不该变」那类负向断言的正向信号：在页面里排一个 `ms` 之后的定时器并等它触发。
 * 定时器按到期先后触发，所以页面里此前已排上、`ms` 之内到期的定时器（秒表的 1 秒心跳、
 * 退避重试）此刻都已经走过一次，由它们引起的请求也已发出（`trackFetches` 里看得见）。
 * 负载再重也只是让它晚点返回，不会让它在那些定时器之前返回。之后再 `settlePage` 读 DOM。
 */
export async function outlastPageTimers(page, ms) {
  await page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);
  await settlePage(page);
}
