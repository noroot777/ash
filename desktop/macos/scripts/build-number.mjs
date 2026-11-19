// 给 CFBundleVersion 发一个比这台机器上以前发过的都大的号，build.sh 拿 lockf 锁着账本调它：
//   lockf -k <账本> node build-number.mjs <账本> [改名前的账本]
//
// 改名前的账本（ash-mac-build-number）只读不写，每次都拿它当底：号只能往上走，换一本空账本就丢了「上一个号」。
// 不先把它抄进新账本 —— 抄那一下在锁外，两份首次构建会互相盖掉对方刚发的号。
// 号的样子是「UTC 日期.时分秒」（拆两段：12 位整数在一些版本比较实现里会溢出），但时刻只是个底：
// 同一秒里打两次、从更早的提交重打、系统时钟往回拨，都必须拿到更大的号 —— 所以账本里记着上一个号，
// 这一次不比它大就在它上面加一。更新器只认 CFBundleVersion 的先后，撞号或倒退都会让它不更新。
import { readFileSync, writeFileSync } from "node:fs";
import { readEnv } from "../../../scripts/env.mjs";

const [book, legacyBook] = process.argv.slice(2);
const parse = (value) => (/^\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null);
const after = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

const clockOverride = readEnv(process.env, "NAVI_MAC_BUILD_CLOCK");
const clock = clockOverride ? new Date(clockOverride) : new Date();
const pad = (n, width = 2) => String(n).padStart(width, "0");
const stamp = `${clock.getUTCFullYear()}${pad(clock.getUTCMonth() + 1)}${pad(clock.getUTCDate())}`
  + `.${pad(clock.getUTCHours())}${pad(clock.getUTCMinutes())}${pad(clock.getUTCSeconds())}`;
const read = (path) => { try { return parse(readFileSync(path, "utf8").trim()); } catch { return null; } };
const last = [read(book), legacyBook ? read(legacyBook) : null].filter(Boolean).reduce((a, b) => (!a || after(b, a) ? b : a), null);
const next = !last || after(parse(stamp), last) ? stamp : `${last[0]}.${pad(last[1] + 1, 6)}`;
writeFileSync(book, `${next}\n`);
process.stdout.write(next);
