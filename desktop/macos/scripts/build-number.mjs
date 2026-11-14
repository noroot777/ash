// 给 CFBundleVersion 发一个比这台机器上以前发过的都大的号，build.sh 拿 lockf 锁着账本调它：
//   lockf -k <账本> node build-number.mjs <账本>
//
// 号的样子是「UTC 日期.时分秒」（拆两段：12 位整数在一些版本比较实现里会溢出），但时刻只是个底：
// 同一秒里打两次、从更早的提交重打、系统时钟往回拨，都必须拿到更大的号 —— 所以账本里记着上一个号，
// 这一次不比它大就在它上面加一。更新器只认 CFBundleVersion 的先后，撞号或倒退都会让它不更新。
import { readFileSync, writeFileSync } from "node:fs";

const [book] = process.argv.slice(2);
const parse = (value) => (/^\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null);
const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

const clock = process.env.ASH_MAC_BUILD_CLOCK ? new Date(process.env.ASH_MAC_BUILD_CLOCK) : new Date();
const pad = (n, width = 2) => String(n).padStart(width, "0");
const stamp = `${clock.getUTCFullYear()}${pad(clock.getUTCMonth() + 1)}${pad(clock.getUTCDate())}`
  + `.${pad(clock.getUTCHours())}${pad(clock.getUTCMinutes())}${pad(clock.getUTCSeconds())}`;
const last = parse(readFileSync(book, "utf8").trim());
const next = !last || after(parse(stamp), last) ? stamp : `${last[0]}.${pad(last[1] + 1, 6)}`;
writeFileSync(book, `${next}\n`);
process.stdout.write(next);
