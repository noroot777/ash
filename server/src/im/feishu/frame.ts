// 飞书长连接的帧格式（官方 SDK 里叫 pbbp2.Frame）。只有这一种消息、九个字段，为它引一整套
// protobufjs 不值当，所以手写编解码。字段号与官方 SDK 1.76.0 的生成代码逐一对齐：
//   1 SeqID uint64 · 2 LogID uint64 · 3 service int32 · 4 method int32
//   5 headers repeated Header{1 key string, 2 value string}
//   6 payload_encoding string · 7 payload_type string · 8 payload bytes · 9 LogIDNew string
// 回执要把收到的帧原样带回（只换 headers 和 payload），所以未用到的字段也得完整保留。

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

export interface FrameHeader {
  key: string;
  value: string;
}

export interface Frame {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: FrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  logIdNew?: string;
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8");

function varint(value: bigint, out: number[]): void {
  let v = BigInt.asUintN(64, value);
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
}

function tag(field: number, wireType: number, out: number[]): void {
  varint(BigInt((field << 3) | wireType), out);
}

function bytesField(field: number, bytes: Uint8Array, out: number[]): void {
  tag(field, 2, out);
  varint(BigInt(bytes.length), out);
  for (const b of bytes) out.push(b);
}

function encodeHeader(header: FrameHeader): Uint8Array {
  const out: number[] = [];
  bytesField(1, utf8.encode(header.key), out);
  bytesField(2, utf8.encode(header.value), out);
  return Uint8Array.from(out);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  tag(1, 0, out); varint(frame.seqId, out);
  tag(2, 0, out); varint(frame.logId, out);
  // int32 的负数按 64 位补码写成 10 字节 varint —— 与 protobuf 规范一致。
  tag(3, 0, out); varint(BigInt(frame.service), out);
  tag(4, 0, out); varint(BigInt(frame.method), out);
  for (const header of frame.headers) bytesField(5, encodeHeader(header), out);
  if (frame.payloadEncoding !== undefined) bytesField(6, utf8.encode(frame.payloadEncoding), out);
  if (frame.payloadType !== undefined) bytesField(7, utf8.encode(frame.payloadType), out);
  if (frame.payload !== undefined) bytesField(8, frame.payload, out);
  if (frame.logIdNew !== undefined) bytesField(9, utf8.encode(frame.logIdNew), out);
  return Uint8Array.from(out);
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.end) throw new Error("frame truncated in varint");
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("varint too long");
    }
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.end) throw new Error("frame truncated in bytes");
    const slice = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.bytes();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

function decodeHeader(bytes: Uint8Array): FrameHeader {
  const r = new Reader(bytes);
  let key = "";
  let value = "";
  while (r.pos < r.end) {
    const t = Number(r.varint());
    const field = t >>> 3;
    if (field === 1) key = fromUtf8.decode(r.bytes());
    else if (field === 2) value = fromUtf8.decode(r.bytes());
    else r.skip(t & 7);
  }
  return { key, value };
}

export function decodeFrame(buf: Uint8Array): Frame {
  const r = new Reader(buf);
  const frame: Frame = { seqId: 0n, logId: 0n, service: 0, method: 0, headers: [] };
  const seen = new Set<number>();
  while (r.pos < r.end) {
    const t = Number(r.varint());
    const field = t >>> 3;
    seen.add(field);
    switch (field) {
      case 1: frame.seqId = r.varint(); break;
      case 2: frame.logId = r.varint(); break;
      case 3: frame.service = Number(BigInt.asIntN(32, r.varint())); break;
      case 4: frame.method = Number(BigInt.asIntN(32, r.varint())); break;
      case 5: frame.headers.push(decodeHeader(r.bytes())); break;
      case 6: frame.payloadEncoding = fromUtf8.decode(r.bytes()); break;
      case 7: frame.payloadType = fromUtf8.decode(r.bytes()); break;
      // 拷一份：subarray 引用着整块接收缓冲，分片缓存里留着它会拖住整帧不释放。
      case 8: frame.payload = r.bytes().slice(); break;
      case 9: frame.logIdNew = fromUtf8.decode(r.bytes()); break;
      default: r.skip(t & 7);
    }
  }
  for (const required of [1, 2, 3, 4]) {
    if (!seen.has(required)) throw new Error(`frame missing required field ${required}`);
  }
  return frame;
}

export function headerOf(frame: Frame, key: string): string | undefined {
  return frame.headers.find((h) => h.key === key)?.value;
}
