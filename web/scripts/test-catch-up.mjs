// 静默追平那一层的**代次纪律**(`src/lib/catchUp.ts`)。
//
// 浏览器那两条用例(test-task-catch-up-dom、test-turn-remedy-catch-up-dom)测的是真断线、
// 真重连、真乱序,但它们造不出「旧代次那一发回来的那一刻,新代次正好欠着一趟」这种三方
// 交错 —— 而那正是第 1 轮审查 F3 的形状:`owed` 当年是个裸 boolean,谁都能清,于是作废的
// 那一发落地时把新代次的待办一并抹掉,既没有请求在途也没有重试在排。
//
// 所以这一条按纯函数测:refetch 换成手工放行的 deferred,timers 换成手工跑的队列,代次与
// 落地顺序完全由测试决定。
import assert from "node:assert/strict";
import { createCatchUp } from "../src/lib/catchUp.ts";

/** 跑完所有已排的微任务(settle 挂在 then 上)。 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const sent = [];
  const timers = [];
  let next = 0;
  const catchUp = createCatchUp(
    () => new Promise((resolve) => { sent.push(resolve); }),
    5000,
    {
      set: (run, delayMs) => { const handle = ++next; timers.push({ handle, run, delayMs }); return handle; },
      clear: (handle) => {
        const at = timers.findIndex((timer) => timer.handle === handle);
        if (at >= 0) timers.splice(at, 1);
      },
    },
  );
  return {
    catchUp,
    timers,
    /** 已经发出去几发。 */
    get count() { return sent.length; },
    /** 放行第 n 发(0 起),ok=false 当「没读到」。 */
    land: async (n, ok = true) => { sent[n](ok); await settled(); },
    fire: async (n) => { const timer = timers.splice(n, 1)[0]; timer.run(); await settled(); },
  };
}

// ① 同代次:至多一发在途,在途期间的触发只攒一笔欠账,落地之后补一发(不是每次触发一发)。
{
  const h = harness();
  h.catchUp.run();
  assert.equal(h.count, 1, "第一次触发就发车");
  h.catchUp.run();
  h.catchUp.run();
  assert.equal(h.count, 1, "在途期间不许并发开第二发");
  await h.land(0);
  assert.equal(h.count, 2, "欠下的那一趟落地之后补上");
  await h.land(1);
  assert.equal(h.count, 2, "补过就不欠了:不许自己接着发");
}

// ② 作废的那一发不许挡住新代次:cancel 不能中止已经出门的传输,但换了代次之后再追平,
//    靠的必须是新代次自己那一发 —— 旧那一发的快照生成于断线之前,物理上不含断线窗口里的
//    变化;何况它可能永远不返回(断线那一下挂在传输层上的请求没有 deadline)。
{
  const h = harness();
  h.catchUp.run();
  h.catchUp.cancel();
  h.catchUp.run();
  assert.equal(h.count, 2, "换了代次要自己发车,不许排在作废的那一发后面");
  await h.land(0); // 旧那一发迟到落地
  assert.equal(h.timers.length, 0, "作废的那一发落地不许续排重试");
}

// ③ **F3 本体**:旧代次落地不许清掉新代次欠下的那一趟。
{
  const h = harness();
  h.catchUp.run();        // 第 0 发,代次 0
  h.catchUp.cancel();     // 断线
  h.catchUp.run();        // 第 1 发,代次 1(重连)
  h.catchUp.run();        // 代次 1 欠一趟
  assert.equal(h.count, 2);
  await h.land(0);        // 作废的那一发现在才回来
  await h.land(1);        // 代次 1 那一发落地:欠下的那一趟必须还在
  assert.equal(h.count, 3, "旧代次落地不许把新代次的待办抹掉(抹掉就既无在途也无重试)");
}

// ④ 没读到要自己排重试;代次作废之后排着的那一条取消,落地的那一发也不再续排。
{
  const h = harness();
  h.catchUp.run();
  await h.land(0, false);
  assert.equal(h.timers.length, 1, "没读到要自己安排下一次");
  assert.equal(h.timers[0].delayMs, 5000);
  await h.fire(0);
  assert.equal(h.count, 2, "重试就是一趟新的读取");
  h.catchUp.cancel();
  assert.equal(h.timers.length, 0, "取消要把排着的重试一并清掉");
  await h.land(1, false);
  assert.equal(h.timers.length, 0, "作废的那一发没读到也不再续排");
  h.catchUp.run();
  assert.equal(h.count, 3, "取消之后还能重新开始");
}

console.log("✓ 追平层的代次纪律:同代次串行攒一笔欠账、换代次自己发车、旧代次落地不清新代次的待办、失败自排重试且取消即停");
