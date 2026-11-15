// 分组的并发名额本身（src/group-slots.ts）：集中还名额、紧接着再来新的，同组总数照样至多四个，
// 都还完之后那份计数也收掉。早先是先减计数、再叫醒等着的那个，被叫醒的还没把自己加回去时计数
// 能归零、记录被删，后来的建出第二份计数，两份各放四个（第 2 轮复审 F2）。
// 成员起跑怎么占名额（轮到之后的重新准入）由 test-dispatch-hold.ts 走真实调度链路钉住。
//
// 跑：npm -w server run test:dispatch-hold（两份连着跑）
import assert from "node:assert/strict";
import { acquireGroupSlot, groupSlotUsage, releaseGroupSlot } from "../src/group-slots.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let active = 0;
let peak = 0;
const holds: Array<() => void> = [];
const occupy = async () => {
  const slot = await acquireGroupSlot("slot-probe");
  peak = Math.max(peak, ++active);
  await new Promise<void>((resolve) => holds.push(resolve));
  active -= 1;
  releaseGroupSlot("slot-probe", slot);
};
const firstFour = [0, 1, 2, 3].map(occupy);
const waiter = occupy();
await sleep(10);
assert.equal(holds.length, 4);
for (const resolve of holds.splice(0)) resolve();
await Promise.all(firstFour);
const nextFour = [0, 1, 2, 3].map(occupy);
for (let i = 0; i < 6; i += 1) {
  await sleep(10);
  assert.ok(active <= 4, `同组同时 ${active} 个`);
  for (const resolve of holds.splice(0)) resolve();
}
await Promise.all([waiter, ...nextFour]);
assert.equal(peak, 4, "峰值就是四个");
assert.deepEqual(groupSlotUsage("slot-probe"), { used: 0, waiting: 0 }, "都还完了，记录也收掉");


console.log("group slots: ok");
