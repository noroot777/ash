// 「AI 协助」几组浏览器回归共用的小工具。用例本身分在两个文件里：
//   · test-preview-assist-ui.mjs          —— 单页生命周期 + 同 context 多标签（①–⑬、⑱、⑲）
//   · preview-assist-fallback-cases.mjs   —— 没有 Web Locks 的降级路（⑭–⑰）
import { fetchLog, fetchesSettled, outlastPageTimers, settlePage, waitUntil } from "./wait-until.mjs";
import { trackStubbedFetches } from "./wait-until-extra.mjs";

/** 读启动脚本输入框里的文字。占位行要读成空串，否则「清空」这一档比不出来。 */
export const editorText = async (editor) => editor.locator(".cm-line").evaluateAll((lines) =>
  lines.map((line) => (line.querySelector(".cm-placeholder") ? "" : line.textContent)).join("\n"));

// ── 条件等待：这几组用例里「过一拍也不该变」「压住的那次读取」靠的都是下面几样事实，不靠睡。
// 夹具在页面里自己当假服务端（换掉了 window.fetch），所以记请求用 trackStubbedFetches，
// 在打开页面之前对整个 context 装一次（window.open 出来的副本页也算在内）。

export const ASSIST_ROUTE = "/preview/assist$";
export const trackAssistFetches = (context) => trackStubbedFetches(context, ASSIST_ROUTE);

/** 跑着时的轮询心跳是 1.2 秒（PreviewAiAssist 的 setInterval）。 */
const POLL_MS = 1200;

/**
 * 「下一拍轮询也不能把它改掉」的正向信号：一个比轮询心跳晚到期的页面定时器触发过（此前排上的
 * 那一拍要发早就发了），在途的读取都已被页面消费完，再冲刷一轮渲染。轮询已经停了的时候它照样
 * 成立 —— 那就只剩「停之前那一发在途的读取已经落地」。
 */
export async function assistPollSettled(page) {
  await outlastPageTimers(page, POLL_MS + 100);
  await fetchesSettled(page, 0, "AI 协助的状态读取都已被页面消费完");
  await settlePage(page);
}

const assistGets = async (page) => (await fetchLog(page)).filter((entry) => entry.method === "GET");

/** 至少 `count` 次状态读取（GET）发出并被页面消费完 —— 「至少跨过了一拍轮询」用它。 */
export async function assistGetsSettled(page, count, message) {
  await waitUntil(async () => {
    const gets = await assistGets(page);
    return gets.length >= count && gets.slice(0, count).every((entry) => entry.state === "settled");
  }, message);
  await settlePage(page);
}

/**
 * 「assist-hold-next-get」压住的那次首次读取：等它真的发出、被夹具扣下（这一刻它要答什么已经
 * 定了），返回它在日志里的位置，供放行后等它落地。
 */
export async function heldGetPending(page) {
  return waitUntil(async () => {
    const log = await fetchLog(page);
    const index = log.findIndex((entry) => entry.method === "GET");
    return index >= 0 && log[index].state === "pending" && { index };
  }, "刷新后的首次状态读取已发出、被夹具压住");
}

/** 放行压住的那次读取，并等页面把它消费完（读完就算，晚到被丢弃的也算），再冲刷一轮。 */
export async function releaseHeldGet(page, held) {
  await page.getByTestId("assist-release-held-get").click();
  await waitUntil(async () => (await fetchLog(page))[held.index]?.state === "settled",
    "压住的那次首次读取放行后已被页面消费完");
  await settlePage(page);
}

/**
 * 让这一页对「谁还拿着这个 claim」的点名一律**扣下不答**（等价于它的 JS 停摆）。返回的函数把
 * 扣下的应答补发出去、之后照常应答 —— 「正主的应答迟到」就靠它排：迟到多久由测试决定，不赌
 * 一个固定毫秒数比副本的静默超时长。不调它就是一直不答（页面刷新后补丁随文档一起没了）。
 */
export async function holdOwnerAnswers(page) {
  await page.evaluate(() => {
    const post = BroadcastChannel.prototype.postMessage;
    const queue = [];
    let open = false;
    window.__releaseOwnerAnswers = () => {
      open = true;
      for (const [channel, note] of queue.splice(0)) {
        try { post.call(channel, note); } catch { /* 那条频道已经关了：这句应答本来也没人收 */ }
      }
    };
    BroadcastChannel.prototype.postMessage = function (note) {
      if (!open && note && typeof note === "object" && note.kind === "held") { queue.push([this, note]); return undefined; }
      return post.call(this, note);
    };
  });
  return () => page.evaluate(() => window.__releaseOwnerAnswers());
}
