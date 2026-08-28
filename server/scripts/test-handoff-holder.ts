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

const marker = (peerUrl: string | null, peerName: string | null): Pick<TaskHandoff, "peerUrl" | "peerName"> =>
  ({ peerUrl, peerName });

const MAC = { name: "mac-mini", url: "http://100.80.239.23:4317", peerFp: "d67f" } satisfies HandoffTarget;
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

console.log("handoff holder resolution tests passed");
