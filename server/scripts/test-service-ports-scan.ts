/**
 * 端口兜底那一档里**不需要真进程**的部分:从输出里认端口(含流式切块等价)、以及探测的
 * 三态合并。从 test-service-ports.ts 按行数拆出来的(全局约定:单文件不超过 700 行),
 * 断言一字未改 —— 那边留下的是要真起守护进程的生命周期用例。
 *
 * 这边钉三件事:
 *   ① 只认本机地址、只认 ≥1024,主机名的左右边界都要卡住(第 1 轮审查发现 5);
 *   ② pty 的输出是**流**,地址会被切成两块送来,任意切法都必须与整条文本等价 —— 尤其不许
 *      把五位端口的前四位当成端口记下来(那个端口上住的是别人,顺着去停止就是误杀);
 *   ③ 「问不出来」自成一档,**不许折叠成「端口空了」**:工具失灵被读成「已经停净」是
 *      第 1 轮审查 E2 的实锤。Windows 上整档不启用,那是「这一档不存在」,与「这一次问不
 *      出来」是两件事(消费者按前者处理)。
 */
import assert from "node:assert/strict";
import { IS_WINDOWS } from "../src/platform.js";
import {
  createPortScanner,
  listeningPids,
  PORT_TIER_AVAILABLE,
  portsFromOutput,
  probePorts,
  stopByPorts,
  type PortProbe,
} from "../src/service-ports.js";

// ── ⑤ 认端口:只认本机地址、只认 ≥1024 ──────────────────────────────────────────
assert.deepEqual(portsFromOutput("[web] http://127.0.0.1:8787"), [8787]);
assert.deepEqual(portsFromOutput("  ➜  Local:   http://localhost:5173/"), [5173]);
assert.deepEqual(portsFromOutput("listening on 0.0.0.0:3000 and http://[::1]:3000"), [3000], "同一个端口只记一次");
assert.deepEqual(portsFromOutput("connected to db.internal:5432"), [], "非本机主机名不是我们起的服务");
assert.deepEqual(portsFromOutput("http://127.0.0.1:80"), [], "低位端口一律不碰:那一档住的是系统服务");
assert.deepEqual(portsFromOutput("已启动 http://127.0.0.1:4000，另一个在 http://localhost:4001"), [4000, 4001]);
assert.deepEqual(portsFromOutput("proxy notlocalhost:8787 ready"), [], "主机名左边界要卡住,否则 xxxlocalhost 也算本机");

// ── ⑤ 跨块等价:同一段文本,整条喂和切开喂必须认出同一批端口 ─────────────────────
{
  const whole = "[web] 服务已启动 http://127.0.0.1:8787 ,另一个在 http://localhost:51730/ \n";
  for (let cut = 1; cut < whole.length; cut += 1) {
    const scanner = createPortScanner();
    const found = [...scanner.feed(whole.slice(0, cut)), ...scanner.feed(whole.slice(cut)), ...scanner.flush()];
    assert.deepEqual(
      found.sort((a, b) => a - b),
      [8787, 51730],
      `在第 ${cut} 个字切开后漏了端口 —— 流式扫描必须与整条等价`,
    );
  }
}
{
  // 最毒的那一刀:五位端口被切在第四位之后。无状态正则会把块尾当合法结尾,记下一个
  // **错的**四位端口 —— 那个端口上住的是别人,顺着它去停止就是误杀。
  const scanner = createPortScanner();
  const first = scanner.feed("listening on http://127.0.0.1:5173");
  assert.deepEqual(first, [], "右边界还没到,这时候任何结论都是猜的");
  assert.deepEqual(scanner.feed("0/\n"), [51730], "边界到了才认,而且认的是完整的那个五位端口");
}
{
  // 切在词中间也不许形成左边界:`notlocalhost` 被切成两半,拼回去仍然不是本机地址。
  const scanner = createPortScanner();
  assert.deepEqual([...scanner.feed("proxy notloc"), ...scanner.feed("alhost:8787 ready"), ...scanner.flush()], []);
}
{
  // 地址恰好是最后一个字:feed 时右边界没到,会话退出那一下 flush 必须把它认出来。
  const scanner = createPortScanner();
  assert.deepEqual(scanner.feed("ready at http://127.0.0.1:8080"), []);
  assert.deepEqual(scanner.flush(), [8080], "流到头了,末尾就是终态");
}
{
  // **地址就坐在流的起点**:没有任何前导字符。保留尾巴时无条件补一个主机名字符当胶水,
  // 就把原本真实存在的左边界(字符串开头)糊掉了 —— 于是 `localhost:8787` 这种
  // (kb.sh 的 `已启动 localhost:8787` 之类)整条漏掉,按钮退回启动、默认停止也找不到它
  // (第 2 轮审查发现 4)。四种裸地址都要认。
  for (const text of ["localhost:8787", "127.0.0.1:8787", "0.0.0.0:8787", "[::1]:8787"]) {
    assert.deepEqual(portsFromOutput(text), [8787], `整条扫描认不出裸地址:${text}`);
    const atOnce = createPortScanner();
    assert.deepEqual(
      [...atOnce.feed(text), ...atOnce.flush()], [8787],
      `流起点的裸地址被漏掉了:${text} —— 流式必须与整条等价`,
    );
    // 切在冒号上:左半块整块进尾巴(它的开头仍是流的起点),右半块补齐才出结论。
    const cut = text.indexOf(":") + 1;
    const split = createPortScanner();
    assert.deepEqual(
      [...split.feed(text.slice(0, cut)), ...split.feed(text.slice(cut)), ...split.flush()], [8787],
      `裸地址切在冒号后就漏了:${text}`,
    );
  }
}
{
  // **穷举等价**:对一批形状各异的文本,把所有「切成两刀」的切法都走一遍,结论必须与整条
  // 扫描完全一致。上面那些单点用例是人挑的,挑漏了就看不出来;这一段是机器挑。
  const corpus = [
    "localhost:8787",
    "[::1]:51730 ready",
    "http://127.0.0.1:8787\n",
    "[web] 已启动 http://localhost:5173/ 另一个 0.0.0.0:51730\n",
    "proxy notlocalhost:8787 ready",
    "127.0.0.1:80 低位不算\nlocalhost:8080\n",
  ];
  let combos = 0;
  for (const text of corpus) {
    const expected = portsFromOutput(text).sort((a, b) => a - b);
    for (let i = 0; i <= text.length; i += 1) {
      for (let j = i; j <= text.length; j += 1) {
        const scanner = createPortScanner();
        const found = [
          ...scanner.feed(text.slice(0, i)),
          ...scanner.feed(text.slice(i, j)),
          ...scanner.feed(text.slice(j)),
          ...scanner.flush(),
        ].sort((a, b) => a - b);
        assert.deepEqual(found, expected, `切在 ${i}/${j} 处与整条不等价:${JSON.stringify(text)}`);
        combos += 1;
      }
    }
  }
  console.log(`  流式等价性:${corpus.length} 段文本 × ${combos} 组切法`);
}

// ── ④ 三态:lsof 失灵与「没人听」是两件事 ───────────────────────────────────────
if (!IS_WINDOWS) {
  const ok = (stdout: string) => (async () => ({ stdout, stderr: "" })) as never;
  const boom = (failure: unknown) => (async () => { throw failure; }) as never;
  assert.deepEqual(await listeningPids(8787, ok("123\n456\n")), { ok: true, pids: [123, 456] });
  // 查无此人:lsof 退 1 且不吭声。这才是「端口空着」。
  assert.deepEqual(await listeningPids(8787, boom({ code: 1, stderr: "", stdout: "" })), { ok: true, pids: [] });
  // 以下三种都是**没答上来**,早先全被 catch 成空数组,于是「工具失灵」被读成「已经停净」。
  const timedOut = await listeningPids(8787, boom({ killed: true, code: null }));
  assert.equal(timedOut.ok, false, "被超时杀掉 ≠ 端口空了");
  const usage = await listeningPids(8787, boom({ code: 1, stderr: "lsof: unsupported option" }));
  assert.equal(usage.ok, false, "退 1 还带着 stderr 是用法/权限错,不是查无此人");
  const missing = await listeningPids(8787, boom({ code: "ENOENT", message: "spawn lsof ENOENT" }));
  assert.equal(missing.ok, false, "lsof 起不来 ≠ 端口空了");

  // 合并优先级:listening > unknown > free。**unknown 不许折叠成 free**。
  const fake = (states: Record<number, PortProbe>) => async (port: number) => states[port];
  const listening: PortProbe = { ok: true, pids: [42] };
  const empty: PortProbe = { ok: true, pids: [] };
  const dunno: PortProbe = { ok: false, why: "没答上来" };
  assert.equal(await probePorts([1, 2], fake({ 1: empty, 2: empty })), "free");
  assert.equal(await probePorts([1, 2], fake({ 1: empty, 2: dunno })), "unknown", "有一个问不出来就不能说停净了");
  assert.equal(await probePorts([1, 2], fake({ 1: dunno, 2: listening })), "listening", "有人听就是开着,没得商量");
  assert.equal(await probePorts([], fake({})), "free", "一个端口都没有,没什么可等的");
  assert.equal(PORT_TIER_AVAILABLE, true, "装了 lsof 的 POSIX 机器上这一档就该启用");
}

if (IS_WINDOWS) {
  // **「这一档不存在」不是「这一次问不出来」**:探测本身照旧如实说「没答上来」,但消费者
  // (openSession / stopLaunchPorts / verifyStopScript)必须按「这一档没有证据」处理。混成
  // 一件,Windows 上每条打印过网址的命令就永远停不掉也起不动:停止一律 502「状态查不出来」、
  // 启动一律 alreadyRunning。
  assert.equal(PORT_TIER_AVAILABLE, false, "Windows 上整档不启用");
  assert.equal(await probePorts([8787]), "unknown", "探测层照实说没答上来,区别由消费者负责");
  // Windows 没有 lsof,这一档整档不启用(service-ports.ts 里直接短路),行为与改动前一致。
  assert.deepEqual(
    await stopByPorts([8787], { launchToken: "irrelevant" }),
    { killed: [], spared: [], unknown: [], leftovers: [] },
  );
}

console.log(`service ports scan test passed${IS_WINDOWS ? " (windows: 端口兜底不启用)" : ""}`);
