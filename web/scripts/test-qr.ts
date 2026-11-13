// 二维码编码器的回归。跑：npm -w web run test:qr
//
// 码画错了不会报错，只会扫不出来 —— 而「扫不出来」要拿真手机对着屏幕才看得见。所以
// 这里钉的是**逐模块**的结果：下面每一行的指纹都取自参考实现（npm `qrcode` 1.5.4，
// 字节模式、纠错等级 M、指定同一个掩模）画出的同一张码，并且用 `jsqr` 解码器扫回过原文。
// 覆盖版本 1–10 的容量边界（分块与交错、校正图形、版本信息都在这条线上）和全部 8 种掩模。
//
// 改了 src/lib/qr.ts 之后指纹对不上 = 画出来的码变了，先拿参考实现重新核对，再更新这张表。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qrMatrix } from "../src/lib/qr.ts";

const fingerprint = (modules: boolean[][]): string =>
  createHash("sha256").update(modules.flat().map((dark) => (dark ? 1 : 0)).join("")).digest("hex").slice(0, 16);

/** 各版本在等级 M 下的字节容量；填满它正好落在那个版本上。 */
const CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
const filler = (length: number): string =>
  Array.from({ length }, (_, i) => String.fromCharCode(48 + ((i * 7) % 75))).join("");

const VECTORS: [text: string, mask: number, size: number, fingerprint: string][] = [
  ["ash", 0, 21, "a4fa25168f181a5c"],
  ["http://192.168.1.250:4317/?pair=Zm9vYmFyYmF6cXV4MTIzNDU2", 1, 33, "2964e8d905f05487"],
  ["http://my-macbook-pro.tailnet-name.ts.net:4317/?pair=Zm9vYmFyYmF6cXV4MTIzNDU2", 2, 37, "44fd3f47549ee106"],
  [filler(CAPACITY[0]!), 3, 21, "b94dbc59da68325f"],
  [filler(CAPACITY[1]!), 4, 25, "1726d3704596a0f4"],
  [filler(CAPACITY[2]!), 5, 29, "3087bfadafa6e57f"],
  [filler(CAPACITY[3]!), 6, 33, "e8ee1178df051048"],
  [filler(CAPACITY[4]!), 7, 37, "0c8678ae4eef19db"],
  [filler(CAPACITY[5]!), 0, 41, "682aac1fec169504"],
  [filler(CAPACITY[6]!), 1, 45, "728ecfd3123e12e9"],
  [filler(CAPACITY[7]!), 2, 49, "677006a31fc12bcb"],
  [filler(CAPACITY[8]!), 3, 53, "d406143ed687256d"],
  [filler(CAPACITY[9]!), 4, 57, "818d6029fa8776c7"],
];

for (const [text, mask, size, expected] of VECTORS) {
  const modules = qrMatrix(text, mask);
  assert.ok(modules, `${text.length} 字节应该装得下`);
  assert.equal(modules.length, size, `${text.length} 字节该落在 ${size}×${size} 那一版`);
  assert.equal(fingerprint(modules), expected, `${text.length} 字节 / 掩模 ${mask}：和参考实现不一致`);
}

// 多一个字节就得升一版；超过版本 10 装不下时明说，不画一张残码。
assert.equal(qrMatrix(filler(CAPACITY[0]! + 1), 0)!.length, 25);
assert.equal(qrMatrix(filler(CAPACITY[9]! + 1)), null);

// 自动选掩模：结果一定是 8 种之一（哪一种不钉 —— 罚分细则各家实现略有出入，都扫得出来）。
{
  const text = VECTORS[1]![0];
  const auto = fingerprint(qrMatrix(text)!);
  const candidates = Array.from({ length: 8 }, (_, mask) => fingerprint(qrMatrix(text, mask)!));
  assert.ok(candidates.includes(auto));
}

console.log("qr: 版本 1–10 × 8 种掩模与参考实现逐模块一致 ✔");
