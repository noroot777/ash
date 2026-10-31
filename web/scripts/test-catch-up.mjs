// 静默追平那一层的**代次纪律与超时纪律**(`src/lib/catchUp.ts`)。
//
// 浏览器那两条用例(test-task-catch-up-dom、test-turn-remedy-catch-up-dom)测的是真断线、
// 真重连、真乱序,但它们造不出「旧代次那一发回来的那一刻,新代次正好欠着一趟」这种三方
// 交错 —— 而那正是第 1 轮审查 F3 的形状:`owed` 当年是个裸 boolean,谁都能清,于是作废的
// 那一发落地时把新代次的待办一并抹掉,既没有请求在途也没有重试在排。它们也造不出「这一发
// 永远不返回」(第 5 轮审查 N1 的形状):真网络里那是反向代理吞响应、服务端卡慢查询、移动端
// 换网而 TCP 没断,在浏览器用例里没法稳定复现。
//
// 所以这一条按纯函数测:refetch 换成手工放行的 deferred,timers 换成手工跑的队列(重试与
// 超时分两摞,免得互相冒充),代次与落地顺序完全由测试决定。
import assert from "node:assert/strict";
import { CATCH_UP_DEADLINE_MS, createCatchUp } from "../src/lib/catchUp.ts";

/** 跑完所有已排的微任务(settle 挂在 then 上)。 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const sent = [];
  const retries = [];
  const deadlines = [];
  let next = 0;
  const catchUp = createCatchUp(
    (signal) => new Promise((resolve) => { sent.push({ resolve, signal }); }),
    {
      retry: 5000,
      timers: {
      set: (run, delayMs, kind) => {
        const handle = ++next;
        assert.ok(kind === "retry" || kind === "deadline", `定时器要说清自己是哪一种,收到 ${kind}`);
        (kind === "deadline" ? deadlines : retries).push({ handle, run, delayMs });
        return handle;
      },
      clear: (handle) => {
        for (const list of [retries, deadlines]) {
          const at = list.findIndex((timer) => timer.handle === handle);
          if (at >= 0) { list.splice(at, 1); return; }
        }
      },
      },
    },
  );
  return {
    catchUp,
    /** 排着的重试(「隔一会儿再读一次」)。 */
    retries,
    /** 排着的超时闸(「这一发等到这里为止」)。 */
    deadlines,
    /** 已经发出去几发。 */
    get count() { return sent.length; },
    /** 第 n 发(0 起)的 AbortSignal。 */
    signal: (n) => sent[n].signal,
    /** 放行第 n 发(0 起),ok=false 当「没读到」。 */
    land: async (n, ok = true) => { sent[n].resolve(ok); await settled(); },
    /** 跑掉排在第 n 位的重试。 */
    fire: async (n) => { const timer = retries.splice(n, 1)[0]; timer.run(); await settled(); },
    /** 让排在第 n 位的超时闸到点。 */
    expire: async (n) => { const timer = deadlines.splice(n, 1)[0]; timer.run(); await settled(); },
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
  assert.equal(h.deadlines.length, 0, "落地了的那几发不许把超时闸留在队列里");
}

// ② 作废的那一发不许挡住新代次:cancel 把在途那一发**连传输一起掐断**并腾出槽位,新代次
//    自己发车 —— 旧那一发的快照生成于断线之前,物理上不含断线窗口里的变化,拿它当追平等于
//    没追;何况掐不掉的那种(调用方不理 signal)可能永远不返回。
{
  const h = harness();
  h.catchUp.run();
  assert.equal(h.signal(0).aborted, false, "在途期间不该被掐");
  h.catchUp.cancel();
  assert.equal(h.signal(0).aborted, true, "作废这一代次就要把在途那一发掐断");
  assert.equal(h.deadlines.length, 0, "作废之后它的超时闸也该收走");
  h.catchUp.run();
  assert.equal(h.count, 2, "换了代次要自己发车,不许排在作废的那一发后面");
  await h.land(0); // 旧那一发迟到落地(调用方不理 signal 的情形)
  assert.equal(h.retries.length, 0, "作废的那一发落地不许续排重试");
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
  assert.equal(h.retries.length, 1, "没读到要自己安排下一次");
  assert.equal(h.retries[0].delayMs, 5000);
  await h.fire(0);
  assert.equal(h.count, 2, "重试就是一趟新的读取");
  h.catchUp.cancel();
  assert.equal(h.retries.length, 0, "取消要把排着的重试一并清掉");
  await h.land(1, false);
  assert.equal(h.retries.length, 0, "作废的那一发没读到也不再续排");
  h.catchUp.run();
  assert.equal(h.count, 3, "取消之后还能重新开始");
}

// ⑤ **N1 本体**:一发永远不返回,不许把这一代次锁死。
//
// 旧版的槽位只在 promise settle 时释放,而传输层没有 deadline ⇒ 这一发挂住之后,后续触发
// 只会记一笔欠账,既没有请求在途、也没有重试在排,界面从此停在旧快照上。
{
  const h = harness();
  h.catchUp.run();
  assert.equal(h.deadlines.length, 1, "每一发都要带一个超时闸");
  assert.equal(h.deadlines[0].delayMs, CATCH_UP_DEADLINE_MS);
  h.catchUp.run();        // 在途期间又有触发:记一笔欠账
  assert.equal(h.count, 1);
  await h.expire(0);      // 到点了,这一发按「没读到」算
  assert.equal(h.signal(0).aborted, true, "放弃等它就要真的掐断,不许只是不看了");
  assert.equal(h.retries.length, 1, "超时之后照常排重试 —— 恢复责任不许凭空消失");
  await h.fire(0);
  assert.equal(h.count, 2, "重试发车:槽位已经腾出来了");
  // 超时之后那一发**真的回来了**:它已经不算数,不许再排一次重试、也不许再补一次欠账。
  await h.land(0, true);
  assert.equal(h.count, 2, "超时之后才回来的那一发不许再触发任何读取");
  assert.equal(h.retries.length, 0);
  await h.land(1, false);
  assert.equal(h.retries.length, 1, "当下这一发自己的失败照常排重试");
}

// ⑥ 超时闸只管自己那一发:先回来的那一发落地时要把闸撤掉,别让它过一会儿去掐下一发。
{
  const h = harness();
  h.catchUp.run();
  await h.land(0, true);
  assert.equal(h.deadlines.length, 0, "落地就撤闸");
  h.catchUp.run();
  assert.equal(h.deadlines.length, 1, "下一发自己带一个新的闸");
  assert.equal(h.signal(1).aborted, false, "上一发的闸不许掐到这一发身上");
}

// ⑦ `run()` 可等待:兑现时机是**这次触发所对应的那一趟落地**。
//
// 为什么要有这条:几处调用方是「点下去 → 等状态刷新 → 解锁按钮」(AcceptGateCard 的几个
// 动作原先各自 await 自己那个 reload)。追平收到这一层之后,如果 run 只是 fire-and-forget,
// 那几处的等待就被悄悄改掉了 —— 按钮会在状态刷新之前解锁,而编译器不会说一句话。
{
  const h = harness();
  let landed = 0;
  void h.catchUp.run().then(() => { landed += 1; });
  await settled();
  assert.equal(landed, 0, "还没落地就不许兑现");
  // 在途期间又触发一次:它记的是欠账,要等到**补发那一趟**落地才算数。
  void h.catchUp.run().then(() => { landed += 10; });
  await h.land(0, true);
  await settled();
  assert.equal(landed, 1, "第一趟落地只兑现第一次触发,欠账那一笔要顺延到补发那一趟");
  assert.equal(h.count, 2, "欠账那一趟确实发了车");
  await h.land(1, true);
  await settled();
  assert.equal(landed, 11, "补发那一趟落地,顺延的那一笔才兑现");
}
{
  // 没读到也算「这一趟结束了」:别把调用方吊到下一次重试去(那是 5 秒之后的事)。
  const h = harness();
  let landed = false;
  void h.catchUp.run().then(() => { landed = true; });
  await h.land(0, false);
  await settled();
  assert.equal(landed, true, "没读到也要兑现,不许吊着等重试");
  assert.equal(h.retries.length, 1, "兑现不影响重试照排");
}
{
  // 作废:等着的那些一并放掉,它等的那一趟不会有了。
  const h = harness();
  let landed = false;
  void h.catchUp.run().then(() => { landed = true; });
  h.catchUp.cancel();
  await settled();
  assert.equal(landed, true, "断线/换任务/卸载之后不许把调用方永远吊着");
}

// ⑧ `runNow()`:**人正等着**那一种触发不许排在一发背景读取后面。
//
// 这一条是修 N1 的过程里实测出来的(test-accept-gate-reads 那一幕):合流语义套到「点了验收
// 通过 → await 状态刷新 → 再 POST」上,那一按要陪一发挂住的背景读取等满 deadline、再陪补发
// 那一趟等满第二个 deadline —— 30 秒之后才发得出去,用户看见的是「按钮坏了」。
{
  const h = harness();
  h.catchUp.run();                  // 背景那一发(挂住了,一直不 settle)
  assert.equal(h.count, 1);
  let landed = false;
  void h.catchUp.runNow().then(() => { landed = true; });
  await settled();
  assert.equal(h.count, 2, "人等着的那一趟要自己发车,不许只记一笔欠账");
  assert.equal(h.signal(0).aborted, true, "被接替的那一发连传输一起掐断");
  assert.equal(h.deadlines.length, 1, "旧那一发的闸跟着撤掉,只剩新那一发的");
  assert.equal(landed, false, "它等的是自己这一趟");
  await h.land(1, true);
  assert.equal(landed, true);
  // 被接替的那一发事后回来:一句话都不许算 —— 既不排重试,也不补欠账(那两件事已经由
  // 接替它的那一趟做完了)。
  await h.land(0, false);
  assert.equal(h.retries.length, 0, "被接替的那一发回来不许再排重试");
  assert.equal(h.count, 2, "也不许凭空再发一趟");
}
{
  // 转交:在途那一发有人在等,被接替时那些人跟到新那一趟上 —— 不许就地兑现(那等于骗他们
  // 说状态已经刷新了),也不许永远吊着。
  const h = harness();
  const order = [];
  void h.catchUp.run().then(() => order.push("背景那一次"));
  await settled();
  void h.catchUp.runNow().then(() => order.push("人等的那一次"));
  await settled();
  assert.deepEqual(order, [], "接替的那一刻谁都还没落地");
  await h.land(1, true);
  assert.deepEqual(order, ["背景那一次", "人等的那一次"], "新那一趟落地时两边一起兑现");
}
{
  // 排着的那次重试被这一次取代(人既然自己点了,就别再在后台另敲一遍)。
  const h = harness();
  h.catchUp.run();
  await h.land(0, false);
  assert.equal(h.retries.length, 1, "没读到先排一次重试");
  h.catchUp.runNow();
  assert.equal(h.retries.length, 0, "显式重读取代排着的那次重试");
  assert.equal(h.count, 2, "并且立刻发车");
}

console.log("✓ 追平层的纪律:同代次串行攒一笔欠账、换代次掐断旧的自己发车、旧代次落地不清新代次的待办、失败自排重试且取消即停、一发挂住到点按没读到算并真掐断、run() 等的是这次触发那一趟、runNow() 抢占在途那一发并把等待者转交给它");
