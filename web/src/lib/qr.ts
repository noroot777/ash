// 二维码编码器(ISO/IEC 18004)。只做这里用得上的那一档:字节模式、纠错等级 M、版本
// 1–10(最多 213 字节,一条带一次性码的地址用不到一半)。
//
// 自己写而不是装一个库:要画的只有「添加设备」那一张码,为它引一份依赖进主包不值当;
// 而这套算法是定死的标准,对不对可以逐位核对 —— `scripts/test-qr.ts` 里钉着和参考实现
// 逐模块一致的指纹,改这个文件之后跑它。
//
// 坐标约定:`modules[y][x]`,y 是行。true = 深色。

/** 各版本的码字总数、等级 M 下每块的纠错码字数与块数(标准表 9)。下标 = 版本 - 1。 */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** 校正图形的中心坐标(标准附录 E)。 */
const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataCodewords = (version: number): number =>
  TOTAL_CODEWORDS[version - 1]! - EC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!;

/** 字节模式的开销:4 位模式指示 + 字符计数(版本 10 起是 16 位)。 */
const headerBits = (version: number): number => 4 + (version < 10 ? 8 : 16);

// ── GF(256) 上的 Reed–Solomon ───────────────────────────────────────────────

function gfMultiply(a: number, b: number): number {
  let product = 0;
  for (let i = 7; i >= 0; i--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> i) & 1) * a;
  }
  return product;
}

/** 生成多项式的系数(最高次项的 1 省略)。 */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

// ── 数据 → 码字 ─────────────────────────────────────────────────────────────

function encodeData(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, headerBits(version) - 4);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return codewords;
}

/** 分块、各算纠错码,再按列交错(短块在前,长块多出来的那个码字排在数据区最后)。 */
function interleave(data: number[], version: number): number[] {
  const blocks = BLOCKS[version - 1]!;
  const ecLength = EC_PER_BLOCK[version - 1]!;
  const shortLength = Math.floor(data.length / blocks);
  const shortBlocks = blocks - (data.length % blocks);
  const divisor = rsDivisor(ecLength);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let i = 0, offset = 0; i < blocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }
  const result: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

// ── 码字 → 矩阵 ─────────────────────────────────────────────────────────────

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

interface Canvas {
  size: number;
  modules: boolean[][];
  /** 功能图形(定位、校正、时序、格式与版本信息):不放数据,也不参与掩模。 */
  reserved: boolean[][];
}

function drawFunctionPatterns(version: number): Canvas {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y]![x] = dark;
    reserved[y]![x] = true;
  };
  // 时序图形。
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // 三个定位图形,连同外圈那一格浅色分隔。
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  // 校正图形(和定位图形重叠的那三个位置不画)。
  const centers = ALIGNMENT[version - 1]!;
  const last = centers.length - 1;
  centers.forEach((cy, i) => centers.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }));
  // 版本信息(版本 7 起):18 位 BCH,左下和右上各一份。
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  drawFormat({ size, modules, reserved }, 0);
  return { size, modules, reserved };
}

/** 格式信息:纠错等级 M(00)+ 掩模号,15 位 BCH,两份。先画一次占位,选定掩模后重画。 */
function drawFormat({ size, modules, reserved }: Canvas, mask: number): void {
  let remainder = mask;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((mask << 10) | remainder) ^ 0x5412;
  const set = (x: number, y: number, i: number) => {
    modules[y]![x] = ((bits >>> i) & 1) === 1;
    reserved[y]![x] = true;
  };
  for (let i = 0; i <= 5; i++) set(8, i, i);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i++) set(14 - i, 8, i);
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, i);
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, i);
  modules[size - 8]![8] = true;
  reserved[size - 8]![8] = true;
}

/** 从右下角起两列一组蛇形往上填。 */
function drawCodewords({ size, modules, reserved }: Canvas, codewords: number[]): void {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if (reserved[y]![x] || i >= codewords.length * 8) continue;
        modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask({ size, modules, reserved }: Canvas, mask: number): void {
  const flip = MASKS[mask]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y]![x] && flip(x, y)) modules[y]![x] = !modules[y]![x];
    }
  }
}

/** 标准 7.8.3 的四条罚分:选罚分最低的掩模,扫码器最不容易认错。 */
function penalty({ size, modules }: Canvas): number {
  let score = 0;
  const lines = [
    ...modules,
    ...Array.from({ length: size }, (_, x) => modules.map((row) => row[x]!)),
  ];
  for (const line of lines) {
    // ① 同色连续 5 个起罚。
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i + 1 < size && line[i + 1] === line[i]) continue;
      if (run >= 5) score += run - 2;
      run = 0;
    }
    // ③ 像定位图形的 1:1:3:1:1,且一侧有 4 格浅色。
    const text = line.map((dark) => (dark ? "1" : "0")).join("");
    for (const pattern of ["10111010000", "00001011101"]) {
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
    }
  }
  // ② 2×2 同色块。
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y]![x]) dark++;
      if (x + 1 < size && y + 1 < size) {
        const color = modules[y]![x];
        if (color === modules[y]![x + 1] && color === modules[y + 1]![x] && color === modules[y + 1]![x + 1]) score += 3;
      }
    }
  }
  // ④ 深浅比例偏离一半,每 5% 罚一次。
  score += Math.floor(Math.abs((dark * 20) / (size * size) - 10)) * 10;
  return score;
}

/**
 * 把一段文本编成二维码矩阵。`mask` 不给就自动选;给了是为了让回归测试能和参考实现逐位
 * 对上(自动选的结果在两套实现之间允许不同,码一样扫得出来)。
 * 装不下(超过版本 10)时回 null。
 */
export function qrMatrix(text: string, mask?: number): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 10 && headerBits(version) + bytes.length * 8 > dataCodewords(version) * 8) version++;
  if (version > 10) return null;

  const codewords = interleave(encodeData(bytes, version), version);
  const build = (choice: number): Canvas => {
    const canvas = drawFunctionPatterns(version);
    drawCodewords(canvas, codewords);
    applyMask(canvas, choice);
    drawFormat(canvas, choice);
    return canvas;
  };
  if (mask !== undefined) return build(mask).modules;
  let best: Canvas | null = null;
  let bestScore = Infinity;
  for (let choice = 0; choice < MASKS.length; choice++) {
    const canvas = build(choice);
    const score = penalty(canvas);
    if (score < bestScore) {
      best = canvas;
      bestScore = score;
    }
  }
  return best!.modules;
}
