// 门禁等待条上那只秒表怎么读。
//
// 单独成一个文件而不是挤在 test-accept-gate-dom.mjs 里：加上轮询之后那份到了 714 行，过了单文件
// 700 行的约定（第 2 轮独立审查实测点出来的）。拆的边界按职责选——「怎么读那只秒表」本来就是
// 一件独立的事，场景只关心读出来的数对不对，所以这两个 helper 整组搬过来，那头只留一次调用。
import assert from "node:assert/strict";

/**
 * 折叠条上那只秒表此刻读出来多少秒。
 *
 * **不钉某个整数**：那一行是真秒表 —— 从夹具 `run()` 的 `startedAt`（90 秒前）起算、每秒自己加一，
 * 所以读到它的那一刻是 30 秒还是 31 秒完全取决于页面加载有多快。整秒钉死过一次，慢环境（门禁
 * 快照冷启动、整套 web 回归排在前面）读到的是「已经 1 分 31 秒」，于是一条跟秒表毫无关系的误红
 * （实证日志 data/runs/Pj2BhkaYHduS/accept-gate-Jt5981iUk1rU.log）。
 *
 * 原来那条要钉的事一点没少，而且拆成了两条更强的（见 test-accept-gate-dom.mjs 的场景 ⑮）：① 读数不小于「startedAt 到现在」
 * 这一段 —— 证明它从开跑那一刻起算，不是定在点下去那一刻的 0 秒；② 读数会往前走 ——
 * 证明它真的在走，不是渲染一次就冻在那儿（这一条整秒断言压根测不出来），由 waitForStopwatchTick 负责。
 */
export const stopwatchSeconds = (text) => {
  const shown = /已经 (?:(\d+) 分 )?(\d+) 秒/.exec(text);
  assert(shown, `折叠那一行要带一只走着的秒表，读到的却是：${text}`);
  return Number(shown[1] ?? 0) * 60 + Number(shown[2]);
};

/**
 * 等到那只秒表真的往前走了一格（有界），返回新读数。
 *
 * **不是「睡 1.2 秒读一次」**：每秒那一跳只是 `setInterval` 排了一次 React 状态更新，真正的提交
 * 还要过浏览器和 React 的调度 —— 主线程上压一个长任务（慢环境、整套回归排在前面、门禁快照冷启动）
 * 就能把它挤到那一刻之后，于是一只走得好好的秒表被判成冻住。第 1 轮独立审查实测复现过：在计时文案
 * 出现后 900ms 处插一个 700ms 的长任务，1.2 秒那一刻读到的还是旧文案（驱动端实测 1580ms），而 3 秒
 * 处已经是「1 分 32 秒」—— 秒表没问题，是断言在替浏览器猜它什么时候渲染完。
 *
 * 换成「读到变大就过、预算用尽还没变才红」：驱动端不再猜，而真冻住的秒表照旧会红（变异测试：摘掉
 * 每秒心跳 → 这里等满预算失败）。
 */
export const waitForStopwatchTick = async (page, bar, from, budgetMs = 10_000) => {
  const deadline = Date.now() + budgetMs;
  let shown = from;
  for (;;) {
    const left = deadline - Date.now();
    assert.ok(left > 0, `秒表要自己走：等了 ${budgetMs} 毫秒，读数一直停在 ${shown} 秒没往前`);
    // 预算也压在读取本身上。不压的话它就不是上界：等待条被异常状态移走时，locator 自己那条
    // 默认等待（30 秒）会先跑完才轮到外层判断（第 2 轮独立审查按代码指出）。读超时按「这一圈
    // 没等到」处理，由上面那条断言在预算用尽时给出秒表那句话，而不是抛一句 Playwright 的
    // TimeoutError —— 失败原因仍然是「没看见它往前走」。
    const text = await bar.innerText({ timeout: left }).catch(() => null);
    if (text !== null) {
      shown = stopwatchSeconds(text);
      if (shown > from) return shown;
    }
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
};
