// 改名之后的本机存储：老版本页面挂在 ash: / ash. / harness-next: 下的键，一启动就整批挪到 navi 前缀，
// 之后各处只认新键。钉住：三种旧前缀都挪、值原样带过去；新键已经在时以新键为准、旧的丢掉；不认识的键不碰；
// 写不进去（配额满）时旧键留着下次再挪；重复跑没有副作用；两份存储（local / session）都挪；而且挪键先于
// 任何模块读存储 —— main.tsx 的第一个 import 就是它，index.html 首帧那段读配色的脚本也认得旧键。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEGACY_STORAGE_PREFIXES, renameLegacyStorageKeys } from "../src/lib/storageRename.ts";

class MemoryStorage {
  constructor(entries = {}, { failOn = () => false } = {}) {
    this.map = new Map(Object.entries(entries));
    this.failOn = failOn;
  }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failOn(key)) throw new Error("QuotaExceededError");
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
  assert.equal(renameLegacyStorageKeys(storage), 5);
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
  assert.equal(renameLegacyStorageKeys(storage), 0, "再跑一遍什么都不动");
}

{
  const storage = new MemoryStorage({ "ash:diff-layout": "unified", "navi:diff-layout": "split", "harness-next:diff-layout": "unified" });
  renameLegacyStorageKeys(storage);
  assert.deepEqual(storage.snapshot(), { "navi:diff-layout": "split" }, "新键已经在就以新的为准，旧的丢掉");
}

{
  const storage = new MemoryStorage({ "ash:big-draft": "x".repeat(10), "ash:small": "1" }, { failOn: (key) => key === "navi:big-draft" });
  assert.equal(renameLegacyStorageKeys(storage), 1);
  assert.deepEqual(storage.snapshot(), { "ash:big-draft": "x".repeat(10), "navi:small": "1" }, "写不进去的那条旧键留着，不拿丢数据换干净");
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

  globalThis.window = {
    localStorage: new MemoryStorage({ "ash:task-scope": "mine" }),
    sessionStorage: new MemoryStorage({ "ash:chat-draft:r1": "半句话" }),
  };
  await import("../src/lib/storageRenameBoot.ts");
  assert.deepEqual(window.localStorage.snapshot(), { "navi:task-scope": "mine" });
  assert.deepEqual(window.sessionStorage.snapshot(), { "navi:chat-draft:r1": "半句话" }, "草稿在 sessionStorage 里，也要挪");
}

// index.html 首帧那段同步脚本在 bundle 之前跑，那时旧键还没挪：它要先认新键、再认旧键。
{
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /localStorage\.getItem\("navi\.colorTheme"\) \|\| localStorage\.getItem\("ash\.colorTheme"\)/);
  const theme = readFileSync(new URL("../src/lib/theme.ts", import.meta.url), "utf8");
  assert.match(theme, /const STORAGE_KEY = "navi\.colorTheme";/, "index.html 与 theme.ts 用同一个键");
}

// 源码里不再有直接写旧前缀的存储键：兼容值只留在 storageRename.ts 那张表里（index.html 那一处上面钉过）。
{
  const { spawnSync } = await import("node:child_process");
  const grep = spawnSync("git", ["grep", "-nE", "[\"`](ash|harness-next)[:.][a-zA-Z$]", "--", "src"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  const stray = grep.stdout.split("\n").filter(Boolean).filter((line) => !line.startsWith("src/lib/storageRename.ts:"));
  assert.deepEqual(stray, [], "这些地方还在直接用旧前缀的键");
}
console.log("PASS storage rename: legacy ash:/ash./harness-next: keys move to navi before anything reads storage");
