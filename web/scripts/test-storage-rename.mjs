// 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
// 之后各处只认新键。钉住：三种旧前缀都挪、值原样带过去；同一个新键有好几代旧值时按代数定胜负（新键 > ash >
// harness-next），跟存储枚举的先后无关；不认识的键不碰；存储快满时先腾出旧键那块地方再写，实在写不进去
// 旧值留在原处、读新键的地方照样读得到，直到新键被写过或删过；重复跑没有副作用；两份存储（local / session）
// 都挪；而且挪键先于任何模块读存储 —— main.tsx 的第一个 import 就是它，index.html 首帧那段读配色的脚本也
// 认得旧键。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keepLegacyReadable, LEGACY_STORAGE_PREFIXES, renameLegacyStorageKeys } from "../src/lib/storageRename.ts";

/** 跟浏览器一样按「键 + 值」的字符数计配额；order 指定枚举顺序（浏览器的枚举顺序不是写入顺序）。 */
class MemoryStorage {
  constructor(entries = {}, { capacity = Infinity, order } = {}) {
    this.map = new Map(Object.entries(entries));
    this.capacity = capacity;
    this.order = order;
  }
  used() { return [...this.map].reduce((sum, [k, v]) => sum + k.length + v.length, 0); }
  get length() { return this.map.size; }
  key(i) {
    const keys = [...this.map.keys()];
    if (this.order) keys.sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b));
    return keys[i] ?? null;
  }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    const before = this.map.has(key) ? key.length + this.map.get(key).length : 0;
    if (this.used() - before + key.length + String(value).length > this.capacity) throw new Error("QuotaExceededError");
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
  snapshot() { return Object.fromEntries([...this.map].sort(([a], [b]) => a.localeCompare(b))); }
}

{
  const storage = new MemoryStorage({
    "ash:sidebar-width": "312",
    "ash:inspector:task:abc": JSON.stringify({ openTabs: ["files"] }),
    "ash.colorTheme": "dark",
    "ash.annotation-batch.t1": "[1,2]",
    "harness-next:diff-layout": "split",
    "theme": "keep-me",
    "ashtray": "keep-me-too",
    "navi:already": "1",
  });
  assert.deepEqual(renameLegacyStorageKeys(storage), { moved: 5, stuck: [] });
  assert.deepEqual(storage.snapshot(), {
    ashtray: "keep-me-too",
    "navi.annotation-batch.t1": "[1,2]",
    "navi.colorTheme": "dark",
    "navi:already": "1",
    "navi:diff-layout": "split",
    "navi:inspector:task:abc": JSON.stringify({ openTabs: ["files"] }),
    "navi:sidebar-width": "312",
    theme: "keep-me",
  }, "三种旧前缀都挪到 navi 下、值原样；不认识的键不碰");
  assert.deepEqual(renameLegacyStorageKeys(storage), { moved: 0, stuck: [] }, "再跑一遍什么都不动");
}

{
  const storage = new MemoryStorage({ "ash:diff-layout": "unified", "navi:diff-layout": "split", "harness-next:diff-layout": "unified" });
  renameLegacyStorageKeys(storage);
  assert.deepEqual(storage.snapshot(), { "navi:diff-layout": "split" }, "新键已经在就以新的为准，旧的丢掉");
}

// 两代旧值同在：浏览器先枚举到更早的 harness-next 那份也不算数，ash 那份更新。
{
  const entries = { "harness-next:sidebar-width": "240", "ash:sidebar-width": "420", "harness-next:sidebar-collapsed": "1", "ash:sidebar-collapsed": "0" };
  const storage = new MemoryStorage(entries, { order: Object.keys(entries) });
  assert.equal(storage.key(0), "harness-next:sidebar-width", "前提：更早那一代先被枚举到");
  assert.deepEqual(renameLegacyStorageKeys(storage), { moved: 4, stuck: [] });
  assert.deepEqual(storage.snapshot(), { "navi:sidebar-collapsed": "0", "navi:sidebar-width": "420" }, "取最近那一代，更早的丢掉");
}

// 存储快满：新键名比旧键长一个字，先写会超；腾出旧键那块地方就写得下。
{
  const draft = "草".repeat(1000);
  const storage = new MemoryStorage({ "ash:assistant-draft:r1": draft, filler: "x".repeat(50) });
  storage.capacity = storage.used() + 1;
  assert.deepEqual(renameLegacyStorageKeys(storage), { moved: 1, stuck: [] });
  assert.deepEqual(storage.snapshot(), { filler: "x".repeat(50), "navi:assistant-draft:r1": draft }, "腾出地方后挪成了");
}

// 腾出地方也写不下（差一个字）：旧值放回原处，读新键的地方照样读到它；新键被写过或删过，旧值才作废。
{
  class StorageLike extends MemoryStorage {}
  const draft = "长草稿".repeat(300);
  // 草稿排在前面先挪，差一个字；后面那条新名更短，照样挪得过去。
  const local = new StorageLike({ "ash:assistant-draft:r1": draft, "harness-next:small": "1", filler: "y".repeat(40) });
  local.capacity = local.used();
  const { stuck } = renameLegacyStorageKeys(local);
  assert.deepEqual(stuck, [{ key: "navi:assistant-draft:r1", legacyKey: "ash:assistant-draft:r1", value: draft }]);
  assert.equal(local.getItem("ash:assistant-draft:r1"), draft, "旧值放回了原处，下次启动再挪");
  assert.equal(local.getItem("navi:small"), "1");
  const other = new StorageLike({ "ash:assistant-draft:r1": "别的存储" });
  keepLegacyReadable(local, stuck, StorageLike.prototype);
  assert.equal(local.getItem("navi:assistant-draft:r1"), draft, "读新键读得到没挪成的旧值");
  assert.equal(other.getItem("navi:assistant-draft:r1"), null, "只垫这一份存储的这几个键");
  assert.equal(local.getItem("navi:unrelated"), null);
  local.setItem("navi:assistant-draft:r1", "在旧草稿上改过");
  assert.equal(local.getItem("navi:assistant-draft:r1"), "在旧草稿上改过");
  assert.equal(local.getItem("ash:assistant-draft:r1"), null, "新键写过之后旧值作废，下次启动不会拿它盖掉新的");
  local.removeItem("navi:assistant-draft:r1");
  assert.equal(local.getItem("navi:assistant-draft:r1"), null, "删掉就是删掉，不会冒出旧值");

  // 连原处都放不回去：这一次靠内存里那份照样读得到。
  const tight = new StorageLike({ "ash:note": "要留下的字" });
  const original = tight.setItem.bind(tight);
  tight.setItem = (key, value) => { if (key.endsWith(":note")) throw new Error("QuotaExceededError"); original(key, value); };
  const lost = renameLegacyStorageKeys(tight).stuck;
  assert.equal(tight.getItem("ash:note"), null);
  delete tight.setItem;
  keepLegacyReadable(tight, lost, StorageLike.prototype);
  assert.equal(tight.getItem("navi:note"), "要留下的字");
}

assert.deepEqual(LEGACY_STORAGE_PREFIXES.map(([, current]) => current).every((current) => current.startsWith("navi")), true);

// 挪键必须先于任何读存储的模块：main.tsx 的第一条 import 就是启动挪键那个副作用模块，它两份存储都挪。
{
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  const firstImport = main.split("\n").find((line) => line.startsWith("import "));
  assert.equal(firstImport, 'import "./lib/storageRenameBoot.ts";');
  const boot = readFileSync(new URL("../src/lib/storageRenameBoot.ts", import.meta.url), "utf8");
  assert.match(boot, /window\.localStorage/);
  assert.match(boot, /window\.sessionStorage/);

  // 浏览器里两份存储共用 Storage.prototype：启动模块垫的就是它。
  globalThis.Storage = class Storage extends MemoryStorage {};
  const session = new Storage({ "ash:chat-draft:r1": "半句话", "ash:chat-draft:r2": "放不下的草稿" });
  session.capacity = session.used();
  globalThis.window = { localStorage: new Storage({ "ash:task-scope": "mine" }), sessionStorage: session };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await import("../src/lib/storageRenameBoot.ts");
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(window.localStorage.snapshot(), { "navi:task-scope": "mine" });
  assert.equal(window.sessionStorage.getItem("navi:chat-draft:r1"), "半句话", "草稿在 sessionStorage 里，也要挪");
  assert.equal(window.sessionStorage.getItem("navi:chat-draft:r2"), "放不下的草稿", "没挪成的那条启动之后照样读得到");
}

// index.html 首帧那段同步脚本在 bundle 之前跑，那时旧键还没挪：它要先认新键、再认旧键。
{
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /localStorage\.getItem\("navi\.colorTheme"\) \|\| localStorage\.getItem\("ash\.colorTheme"\)/);
  const theme = readFileSync(new URL("../src/lib/theme.ts", import.meta.url), "utf8");
  assert.match(theme, /const STORAGE_KEY = "navi\.colorTheme";/, "index.html 与 theme.ts 用同一个键");
}

// 预览助手的锁名和频道名是新旧两版同时活着的页面之间对话用的：改了名两边就互相看不见，两份都会认自己是正主。
{
  const tabs = readFileSync(new URL("../src/settings/previewAssistTabs.ts", import.meta.url), "utf8");
  assert.match(tabs, /const CHANNEL = "ash:preview-assist-claims";/);
  assert.match(tabs, /const LOCK = \(projectId: string, claim: string\) => `ash:preview-assist:\$\{projectId\}:\$\{claim\}`;/);
}

// 源码里不再有直接写旧前缀的存储键：兼容值只留在 storageRename.ts 那张表里（index.html 那一处上面钉过）。
{
  const { spawnSync } = await import("node:child_process");
  const grep = spawnSync("git", ["grep", "-nE", "[\"`](ash|harness-next)[:.][a-zA-Z$]", "--", "src"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  // previewAssistTabs.ts 的锁名和频道名是新旧两版页面之间对话用的，故意沿用旧名（见那里的注释）。
  const exempt = ["src/lib/storageRename.ts:", "src/settings/previewAssistTabs.ts:"];
  const stray = grep.stdout.split("\n").filter(Boolean).filter((line) => !exempt.some((file) => line.startsWith(file)));
  assert.deepEqual(stray, [], "这些地方还在直接用旧前缀的键");
}
console.log("PASS storage rename: legacy ash:/ash./harness-next: keys move to navi before anything reads storage, newest generation wins, and what does not fit stays readable");
