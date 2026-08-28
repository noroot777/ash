// 出站行的持有机怎么认（shared 的 outboundHolder）。
//
// 起因：mac-mini 重装后 tailscale 换了 IP，接力设置里那条 url 还写着旧地址，于是侧栏
// 一直说「联系不上 mac-mini」——而那台机器的 ash 好好跑着。用户去设置里把地址改对之后
// 问题**更隐蔽**了：历史出站行的 marker 里冻的还是旧地址，按 url 匹配 target 匹配不上，
// 整台机器被轮询**静默跳过** —— 既不显示实时状态、也不再说「联系不上」，屏幕上只剩一份
// 冻住的旧状态在冒充实时。这个测试钉住的就是「改完地址，历史行跟着走」。
import assert from "node:assert/strict";
import type { HandoffTarget, TaskHandoff } from "@ash/shared";
import { normalizedPeerUrl, outboundHolder } from "@ash/shared/handoff";

const marker = (
  peerUrl: string | null,
  peerName: string | null,
  peerFp?: string | null,
): Pick<TaskHandoff, "peerUrl" | "peerName" | "peerFp"> => ({ peerUrl, peerName, peerFp });

const FP_MAC = "d67fcd0748e71ddf59b9131dc9dd998247ae2d463b14cd10052e09ba00f2e0e9";
const FP_OTHER = "7df1f3ebe98e445e778cdedcb704006dac69c7e0e7a23b109fa1bb606674c6a3";

const MAC = { name: "mac-mini", url: "http://100.80.239.23:4317", peerFp: FP_MAC } satisfies HandoffTarget;
const COMP = { name: "comp", url: "http://172.16.88.252:4317" } satisfies HandoffTarget;
const TARGETS: HandoffTarget[] = [MAC, COMP];

// 地址归一：尾斜杠和 /api 后缀都不该让同一台机器看着像两台。
assert.equal(normalizedPeerUrl("http://a:4317/"), "http://a:4317");
assert.equal(normalizedPeerUrl("http://a:4317/api"), "http://a:4317");
assert.equal(normalizedPeerUrl(null), "");
assert.equal(normalizedPeerUrl(undefined), "");

// 地址对得上：就是它，名字都不用看。
assert.equal(outboundHolder(marker("http://100.80.239.23:4317", "mac-mini"), TARGETS), MAC);
assert.equal(outboundHolder(marker("http://100.80.239.23:4317/", "随便写的名字"), TARGETS), MAC);
assert.equal(outboundHolder(marker("http://172.16.88.252:4317", "comp"), TARGETS), COMP);

// **本体**：机器换了地址，设置里改过 url，历史 marker 还冻着旧地址 —— 按名字认回同一台。
assert.equal(outboundHolder(marker("http://100.101.193.79:4317", "mac-mini"), TARGETS), MAC);
assert.equal(outboundHolder(marker("http://192.168.5.5:4317", " mac-mini "), TARGETS), MAC, "名字两边的空格不算区别");

// 设置里真的没有这台了（用户把它删了）：认不出来就是认不出来，别硬塞给别人。
assert.equal(outboundHolder(marker("http://100.101.193.79:4317", "老机器"), TARGETS), null);
assert.equal(outboundHolder(marker("http://100.101.193.79:4317", null), TARGETS), null);
assert.equal(outboundHolder(marker(null, null), TARGETS), null);
assert.equal(outboundHolder(null, TARGETS), null);
assert.equal(outboundHolder(marker("http://100.80.239.23:4317", "mac-mini"), []), null);

// 地址匹配优先于名字：两条 target 重了名时，地址说了算 —— 否则「按名字认」会把明明
// 指得准的那一条抢走。
const DUP: HandoffTarget[] = [
  { name: "mac-mini", url: "http://10.0.0.1:4317" },
  { name: "mac-mini", url: "http://10.0.0.2:4317" },
];
assert.equal(outboundHolder(marker("http://10.0.0.2:4317", "mac-mini"), DUP), DUP[1]);
// 地址谁也对不上时才回落到名字，取头一条（重名本身在界面上就已经分不出来了）。
assert.equal(outboundHolder(marker("http://10.0.0.9:4317", "mac-mini"), DUP), DUP[0]);

// ── 指纹这一档（第 1 轮审查提出）────────────────────────────────────────────
// 名字是用户随手填的、能重；指纹是公钥的 sha256，才是机器真正的身份。marker 里有它
// 就必须先用它 —— 否则「按名字认」会在重名时把出站行路由到**另一台机器**：轮询问错人、
// 「在对端打开」拼出错的 URL、点开出站行进错的 RemoteTaskDetail。
const MOVED_WRONG = { name: "mac-mini", url: "http://wrong:4317", peerFp: FP_OTHER } satisfies HandoffTarget;
const MOVED_RIGHT = { name: "mac-mini", url: "http://right:4317", peerFp: FP_MAC } satisfies HandoffTarget;
assert.equal(
  outboundHolder(marker("http://old:4317", "mac-mini", FP_MAC), [MOVED_WRONG, MOVED_RIGHT]),
  MOVED_RIGHT,
  "同名两台时按指纹认对的那台，而不是数组里靠前的那台",
);
// 名字都对不上也照样按指纹认得出来：用户改地址时顺手把名字也改了，是很常见的一次编辑。
assert.equal(
  outboundHolder(marker("http://old:4317", "旧名字", FP_MAC), [COMP, MOVED_RIGHT]),
  MOVED_RIGHT,
  "指纹在，名字改了也认得回来",
);
// 指纹**明确冲突**的一律不选，哪怕名字一模一样 —— 它已经自证不是同一台机器。
assert.equal(
  outboundHolder(marker("http://old:4317", "mac-mini", FP_MAC), [MOVED_WRONG]),
  null,
  "只剩一条同名但指纹对不上的，宁可认不出也不能认它",
);
// 老记录（marker 没存 peerFp）仍走名字：那时名字是仅剩的线索，不能因为 target 有指纹就出局。
assert.equal(outboundHolder(marker("http://old:4317", "mac-mini"), [MOVED_WRONG]), MOVED_WRONG);
// 反过来，设置里那条还没记过指纹（首次接力前 / 用户手动清过）也不该被指纹挡住。
const FRESH = { name: "mac-mini", url: "http://fresh:4317" } satisfies HandoffTarget;
assert.equal(outboundHolder(marker("http://old:4317", "mac-mini", FP_MAC), [FRESH]), FRESH);

// ── 指纹这道闸对**地址**那一档也生效（第 2 轮审查提出）──────────────────────
// 「门牌没变、屋里换了人」：地址会被 DHCP / tailscale 回收给别的设备，而历史 marker 还
// 记着原来那台的指纹。地址撞上就直接返回的话，状态轮询会把出站任务 id 发给一台陌生机器,
//「在对端打开」会拼出它的 URL,点开出站行也会进它的 RemoteTaskDetail。
const SAME_URL_OTHER = { name: "mac-mini", url: "http://same:4317", peerFp: FP_OTHER } satisfies HandoffTarget;
assert.equal(
  outboundHolder(marker("http://same:4317", "mac-mini", FP_MAC), [SAME_URL_OTHER]),
  null,
  "地址一样但指纹是另一台：宁可认不出，也不能把它当成持有机",
);
// 同一个地址上换了人，而真正那台在设置里换了地址躺着 —— 要认后者。
const REAL_MOVED = { name: "mac-mini", url: "http://moved:4317", peerFp: FP_MAC } satisfies HandoffTarget;
assert.equal(
  outboundHolder(marker("http://same:4317", "mac-mini", FP_MAC), [SAME_URL_OTHER, REAL_MOVED]),
  REAL_MOVED,
  "地址那条被指纹否掉之后，要接着按指纹找到真正那台",
);
// 名字也一样、地址也一样，但指纹冲突 —— 三档一个都不能放它过。
assert.equal(outboundHolder(marker("http://same:4317", "mac-mini", FP_MAC), [SAME_URL_OTHER, COMP]), null);

console.log("handoff holder resolution tests passed");
