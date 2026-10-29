// `test-ash-mcp-probe.ts` 第 9、11 块：探测层的**结构约束**，以及「没启动」/门闩扫地两条。
// 单拆出来只是为了让主测试文件守住 700 行上限 —— 它们仍由主测试调用、跟着
// `test:ash-mcp-probe` 一起跑，不是独立的回归。
//
// macOS 上圈定如实弃权，所以「圈建不成 → 不启动」「整圈刀 → 核销」这两条只能在真机上
// 跑。断言刻意写成**否定式**（危险形状不存在）而不是某一种写法 —— 上一轮钉
// `return gone ?? byClose` 的表达式形状，实现一换就恒红，而恒红的断言钉不住任何东西。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { probeCli as ProbeCli } from "../src/ash-mcp-probe.js";
import { sweepStaleGates } from "../src/ash-mcp-gate.js";

export function checkProbeStructure(): void {
  const src = readFileSync(new URL("../src/ash-mcp-probe.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");

  const fnBody = (body: string, head: string): string => {
    const at = body.indexOf(head);
    assert.ok(at >= 0, `${head} 不见了`);
    const end = body.indexOf("\n}", at);
    return body.slice(at, end > 0 ? end : undefined);
  };

  // **一台归属设备都拿不到时，一条指令都不准起。** 写成位置关系而不是某一句的形状：
  // 要的不变量是「这道闸在 spawn 之前」。
  const probeBody = fnBody(code, "export async function probeCli");
  const guardAt = probeBody.search(/if \(!confine\) return notStarted\(/);
  const spawnAt = probeBody.indexOf("spawn(launch.file");
  assert.ok(guardAt >= 0 && spawnAt > guardAt,
    "拿不到能核销的归属设备就不做这次探测 —— 不准退回直接起 CLI（第 6 轮 B1 / 第 1 轮 B1）");

  // **进程组不准再参与核销**（第 1 轮 B1）：后代一个 setsid 就出圈，原组的 ESRCH 推不出
  // 整次运行干净。组刀照留（killTree 内部那一刀在 platform.ts），但这个文件里不准再出现
  // 拿进程组**探活**的写法。
  assert.ok(!/kill\(-\s*\w+\s*,\s*0\s*\)/.test(code),
    "原组的 ESRCH 不是「整次运行已清理」的证据（第 1 轮 B1，macOS 真机实测）");
  // **追踪 fd 整台设备已经撤掉**（第 2 轮 N4/N5）。两条理由各自独立成立：
  //  · 它到不了 CLI —— 门闩那一跳是 `spawnSync(stdio: "inherit")`，只转发 0/1/2，
  //    Node 的 spawn 又把非 stdio 的 fd 都 CLOEXEC 掉（本轮实测：`lsof` 答空，而 `ps`
  //    明明看得见那个后代）。断了之后它答的正是「没人握着」—— 一个假的核销。
  //  · 就算接通也是冗余的 —— 在「圈定不完整就不启动」之下，能被 lsof 看见的后代必然
  //    已经在圈里，圈的读数本来就覆盖它。
  assert.ok(!/TrackFd|trackHolders|probeFileHolders|residueFromProbe|holdersMayExist/.test(code),
    "追踪 fd 在这条链上只会答出一个假的「空」，而且冗余 —— 不准再接回来（第 2 轮 N4/N5）");

  // **下刀的返回值不构成核销**（第 2 轮 B1）：Linux <5.14 那条降级路径枚举成员逐个
  // `killOne`，失败被咽掉照样 `sent += 1`，返回的是**尝试数** —— 跟 `cgroup.kill` 那条
  // 真原子路径返回的 1 长得一模一样，调用方分辨不出来。所以不准据它判事。
  // 同步/异步两版下刀（`killAll` / `killAllAsync`）都在这条规矩里，查整份文件而不只是
  // `settleUnit` —— 下刀已经收进了 `cutUnit` 那个小函数。
  const settleBody = fnBody(code, "async function settleUnit");
  const KILL = String.raw`(?:await\s+)?[\w.?]*killAll(?:Async)?\(`;
  assert.ok(!new RegExp(String.raw`(?:const|let|var)\s+\w+\s*=\s*${KILL}`).test(code),
    "killAll 的返回值不准存下来 —— 存下来就是打算拿它判事（第 2 轮 B1）");
  assert.ok(!new RegExp(String.raw`(?:if|while|\?\?|&&|\|\||return)\s*\(?${KILL}`).test(code),
    "killAll 的返回值不准参与判断（降级路径返回的是尝试数，第 2 轮 B1）");
  // 正面那半：下刀之后必须回到**读数**上去证。
  assert.ok(!/(?:killAll(?:Async)?|cutUnit)\([^)]*\);\s*killTree\([^)]*\);\s*discharge\(/.test(settleBody),
    "不准杀完就核销 —— 中间必须有一次读数（第 2 轮 B1）");
  assert.match(settleBody, /while \([\s\S]*?unitResidue\(unit\)[\s\S]*?\}/,
    "复核要成环地问，直到证空或者预算用完");
  // **钉函数体里有哪几件事，不钉它们写成什么样。** 这一轮和上一轮各被形状断言咬过一次：
  // 钉 `return gone ?? byClose`、钉 `confine.read().kind === …` 的那两条，实现一换写法就
  // 恒红，而恒红的断言钉不住任何东西。
  assert.match(code, /confirmHeld\(/, "开门之前必须确认归属，不能直接 open");
  const confirm = fnBody(code, "async function confirmHeld");
  assert.match(confirm, /enroll\(pid\)/, "确认归属要先 enroll");
  // enroll 写的是 Node stream，read() 内部 Atomics.wait 会把事件循环堵死 —— 中间不把那次
  // 写等出去，hold 请求根本发不出去（真机实测：第一次碰巧成功，之后是 absent）。
  assert.match(confirm, /await wait\(HOLD_FLUSH_MS\)/,
    "enroll 之后必须把那次异步写等出去（第 6 轮真机）");
  assert.match(confirm, /kind === "members"/,
    "enroll 答 true 只说明请求发出去了 —— 必须读到 members 才算圈真的建成");
  assert.match(code, /await settleUnit\([^)]*"timeout"\)/,
    "超时路径必须**等**收尾做完才说「问不出来」");
  assert.match(code, /void settleUnit\([^)]*"ended"\)/,
    "正常结束路径也必须收尾（根 close 不代表后代结束）");

  assert.ok(!/byClose/.test(code),
    "close 不准再当证据：后代不持管道时它来得更早，持管道时它根本不来（第 6 轮第 4 点）");
  assert.ok(!/finally\s*\{[\s\S]{0,200}?dispose\(/.test(code),
    "finally 里不准撤销身份：dispose 的契约是「调用方已经判空」，它自己不杀成员");

  // **判据层不准拿预判当分支**（新链第 2 轮第 1 条）：走 CLI 档还是文件档，只看探测自己的
  // 收场（`not-started`）。预判跟探测真实的失败面对不上 —— 一引用它，「预判说能、真起不来」
  // 那条路就又落回「问不出来 ⇒ 放行」。
  const reach = readFileSync(new URL("../src/ash-mcp-reachability.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");
  assert.ok(!/confineAbstention/.test(reach),
    "判据层不准引用 confineAbstention —— 分支依据必须是这次探测的收场");
  assert.match(reach, /state === "not-started"\) return fromFiles\(/,
    "没启动起来的那一问要退到配置文件那一档，不是放行");
}

/**
 * 一条指令都没起的那几种收场，必须答「没启动」而不是「问不出来」—— 判据层只有拿到前者才会
 * 退到配置文件那一档（新链第 2 轮第 1 条）。两种都不准把目标执行起来。
 */
export async function checkNotStarted(probeCli: typeof ProbeCli): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), "ash-mcp-notstarted-"));
  try {
    const marker = join(stage, "ran");
    const args = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
    // ① 一台归属设备都拿不到（不管预判怎么说）。
    const none = await probeCli("node", args, process.env, undefined, 3_000, () => null);
    assert.equal(none.kind, "not-started", `拿不到归属设备 ⇒ 没启动：${JSON.stringify(none)}`);
    assert.ok(none.kind === "not-started" && none.why.trim(), "要说得出为什么没启动");
    // ② 设备给了，但这一次圈没建成（enroll 失败）—— 预判说「能」、运行期起不来的那种形状。
    const broken = {
      id: "broken", enroll: () => false, preExecEnv: () => null,
      read: () => ({ kind: "absent", why: "没建成" }), killAll: () => 0, dispose: () => {},
    } as unknown as NonNullable<ReturnType<NonNullable<Parameters<typeof ProbeCli>[5]>>>;
    const unheld = await probeCli("node", args, process.env, undefined, 3_000, () => broken);
    assert.equal(unheld.kind, "not-started", `圈没建成 ⇒ 没启动：${JSON.stringify(unheld)}`);
    assert.ok(!existsSync(marker), "没启动的那几种收场，目标一条指令都不准执行");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * 门闩目录的回收不能只靠那个不被等待的后台收尾（新链第 2 轮第 4 条）：启动扫地按 mtime 收掉
 * 陈旧的，刚建的不碰（可能是另一个 ash 实例正用着的）。
 */
export function checkGateSweep(): void {
  const root = mkdtempSync(join(tmpdir(), "ash-mcp-gate-sweep-"));
  try {
    const stale = join(root, "stale");
    const fresh = join(root, "fresh");
    mkdirSync(stale);
    mkdirSync(fresh);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);
    assert.equal(sweepStaleGates(Date.now(), root), 1, "只收陈旧的那一个");
    assert.ok(!existsSync(stale), "陈旧的门闩目录要被收掉");
    assert.ok(existsSync(fresh), "刚建的不准碰 —— 可能有探测正用着");
    assert.equal(sweepStaleGates(Date.now(), join(root, "missing")), 0, "根目录不存在时安静返回");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
