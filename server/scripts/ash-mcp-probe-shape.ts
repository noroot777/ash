// `test-ash-mcp-probe.ts` 第 9 块：探测层的**结构约束**。单拆出来只是为了让主测试文件守住
// 700 行上限 —— 它仍由主测试调用、跟着 `test:ash-mcp-probe` 一起跑，不是一条独立的回归。
//
// macOS 上圈定如实弃权，所以「圈建不成 → 不启动」「整圈刀 → 核销」这两条只能在真机上
// 跑。断言刻意写成**否定式**（危险形状不存在）而不是某一种写法 —— 上一轮钉
// `return gone ?? byClose` 的表达式形状，实现一换就恒红，而恒红的断言钉不住任何东西。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  const guardAt = probeBody.search(/if \(!confine\) return null;/);
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
}
