// 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
// 之后各处只认新键。钉住：三种旧前缀都挪、值原样带过去；同一个新键有好几代旧值时按代数定胜负（新键 > ash >
// harness-next），跟存储枚举的先后无关；不认识的键不碰；写不进新键时旧键一个字不动（刷新之后照样在、照样
// 读得到），写新键写不下就在旧键原地更新，写进新键后旧键才作废；重复跑没有副作用；两份存储（local / session）
// 都挪；而且挪键先于任何模块读存储 —— main.tsx 的第一个 import 就是它，index.html 首帧那段读配色的脚本也
// 认得旧键。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keepLegacyReadable, LEGACY_STORAGE_PREFIXES, renameLegacyStorageKeys, storageKeys } from "../src/lib/storageRename.ts";

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

// 存储快满：新键要和旧键同时放得下才挪（先写新的、写进去了才删旧的）；放不下就暂缓改名，旧键一个字不动。
{
  const draft = "草".repeat(1000);
  const roomy = new MemoryStorage({ "ash:assistant-draft:r1": draft });
  roomy.capacity = roomy.used() + "navi:assistant-draft:r1".length + draft.length;
  assert.deepEqual(renameLegacyStorageKeys(roomy), { moved: 1, stuck: [] });
  assert.deepEqual(roomy.snapshot(), { "navi:assistant-draft:r1": draft }, "放得下两份就挪成");

  const tight = new MemoryStorage({ "ash:assistant-draft:r1": draft });
  tight.capacity = tight.used() + 1;
  assert.deepEqual(renameLegacyStorageKeys(tight).stuck, [{ key: "navi:assistant-draft:r1", legacyKey: "ash:assistant-draft:r1" }]);
  assert.deepEqual(tight.snapshot(), { "ash:assistant-draft:r1": draft }, "放不下两份：旧键原样留着，不先删");
}

// 没挪成的那条：读新键读得到旧值；刷新（新的一份文档、同一块存储）之后旧值还在、照样读得到；新键写不下时在旧键
// 原地更新，刷新后读到的是改过的那份；腾出地方后写新键，旧键随之作废；删新键连旧键一起删。
{
  class StorageLike extends MemoryStorage {}
  const reload = (storage) => {
    const fresh = new StorageLike();
    fresh.map = storage.map;
    fresh.capacity = storage.capacity;
    const { stuck } = renameLegacyStorageKeys(fresh);
    keepLegacyReadable(fresh, stuck, StorageLike.prototype);
    return fresh;
  };
  const draft = "长草稿".repeat(300);
  // 草稿差一大截放不下；后面那条新名更短、值也小，照样挪得过去。
  const first = new StorageLike({ "ash:assistant-draft:r1": draft, "harness-next:small": "1", filler: "y".repeat(40) });
  first.capacity = first.used() + "navi:small".length + 1;
  const { stuck } = renameLegacyStorageKeys(first);
  assert.deepEqual(stuck, [{ key: "navi:assistant-draft:r1", legacyKey: "ash:assistant-draft:r1" }]);
  assert.equal(first.getItem("navi:small"), "1");
  keepLegacyReadable(first, stuck, StorageLike.prototype);
  const other = new StorageLike({ "ash:assistant-draft:r1": "别的存储" });
  assert.equal(first.getItem("navi:assistant-draft:r1"), draft, "读新键读得到没挪成的旧值");
  assert.equal(other.getItem("navi:assistant-draft:r1"), null, "只垫这一份存储的这几个键");
  assert.equal(first.getItem("navi:unrelated"), null);

  let page = reload(first);
  assert.equal(page.getItem("ash:assistant-draft:r1"), draft, "刷新之后旧值还在存储里");
  assert.equal(page.getItem("navi:assistant-draft:r1"), draft, "刷新之后照样读得到");

  const edited = "改过稿".repeat(300); // 跟旧草稿一样长：原地放得下
  page.setItem("navi:assistant-draft:r1", edited);
  assert.equal(page.getItem("navi:assistant-draft:r1"), edited);
  assert.equal(page.map.has("navi:assistant-draft:r1"), false, "新键写不下");
  page = reload(page);
  assert.equal(page.getItem("navi:assistant-draft:r1"), edited, "在旧键原地更新过，刷新后读到改过的那份");

  page.capacity = Infinity;
  page.setItem("navi:assistant-draft:r1", "放得下了");
  assert.deepEqual([page.getItem("navi:assistant-draft:r1"), page.map.has("ash:assistant-draft:r1")], ["放得下了", false], "写进新键之后旧键作废");
  page = reload(page);
  assert.equal(page.getItem("navi:assistant-draft:r1"), "放得下了", "刷新之后也不会被旧值盖掉");

  const removing = reload(new StorageLike({ "ash:note": "x".repeat(50) }, { capacity: 60 }));
  removing.removeItem("navi:note");
  assert.equal(removing.getItem("navi:note"), null, "删掉就是删掉，不会冒出旧值");
  assert.equal(removing.map.has("ash:note"), false);
}

// 按前缀枚举键的地方（清退 Inspector 默认面板）：没挪成、暂留在旧名下的面板状态按新名列出来，照样被清退；
// 不然清退记了「做过了」，以后挪成了也不会再清。
{
  class Panels extends MemoryStorage {}
  const state = JSON.stringify({ openTabs: ["monitors", "files"], activeTab: "monitors", visible: true, pad: "p".repeat(200) });
  const storage = new Panels({ "ash:inspector:task:t1": state, "navi:other": "1" });
  storage.capacity = storage.used() + 40; // 清退记账那一条写得下，面板状态挪不过去
  const { stuck } = renameLegacyStorageKeys(storage);
  assert.deepEqual(stuck, [{ key: "navi:inspector:task:t1", legacyKey: "ash:inspector:task:t1" }]);
  keepLegacyReadable(storage, stuck, Panels.prototype);
  assert.deepEqual(storageKeys(storage).sort(), ["navi:inspector:task:t1", "navi:other"], "按新名列");
  globalThis.window = { localStorage: storage };
  const { retireInspectorTab } = await import("../src/inspector/retiredTabs.ts");
  retireInspectorTab("monitors-off", /^navi:inspector:task:/, "monitors");
  delete globalThis.window;
  const after = JSON.parse(storage.getItem("navi:inspector:task:t1"));
  assert.deepEqual([after.openTabs, after.activeTab], [["files"], "files"], "暂留在旧名下的面板状态也清退了");
}

// 写什么都失败（不只是配额满）：旧值从头到尾都在存储里，刷新后照样读得到；写新键整个失败时把错抛给调用方、旧内容不动。
{
  class Broken extends MemoryStorage {
    setItem(key, value) { if (this.broken) throw new Error("QuotaExceededError"); super.setItem(key, value); }
  }
  const storage = new Broken({ "ash:note": "要留下的字" });
  storage.broken = true;
  const { stuck } = renameLegacyStorageKeys(storage);
  assert.equal(storage.getItem("ash:note"), "要留下的字", "迁移失败不删旧键");
  keepLegacyReadable(storage, stuck, Broken.prototype);
  assert.throws(() => storage.setItem("navi:note", "新写的"), /QuotaExceededError/, "写不进就照常报错");
  assert.equal(storage.getItem("navi:note"), "要留下的字", "旧内容不动、照样读得到");
  const reloaded = new Broken();
  reloaded.map = storage.map;
  reloaded.broken = true;
  keepLegacyReadable(reloaded, renameLegacyStorageKeys(reloaded).stuck, Broken.prototype);
  assert.equal(reloaded.getItem("navi:note"), "要留下的字", "刷新之后照样在");
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
  session.capacity = session.used() + "navi:chat-draft:r1".length + "半句话".length; // r1 放得下两份，r2 放不下
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
