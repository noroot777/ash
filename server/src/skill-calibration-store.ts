import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHarnessDbFile } from "./db/path.js";

// init 事件校准的**冷启动来源**。
//
// 校准本身只能搭 claude 启动时那一行 JSON 的便车(绝不为了拿清单主动跑一次 CLI,
// 见 skills.ts 顶部),于是它天然只活在进程内存里 —— server 一重启,`/compact`、
// `/review` 这些**磁盘上根本不存在**的内置命令就从斜杠菜单里消失了,直到下一次有
// claude 跑起来。而重启后最需要 `/compact` 的恰恰是那些已经跑到高水位的老会话
// (第 3 轮审查 finding 4)。
//
// 所以把最近这些校准落一个小 JSON:内容全部来自真 CLI 自报,不是我们猜的名单。
// 落在**库文件旁边**而不是写死 data/ —— 预览实例、测试各自把 HARNESS_DB 指到别处,
// 校准也就跟着分开,不会互相污染。
const FILE = () => join(dirname(resolveHarnessDbFile()), "skill-calibrations.json");

/**
 * 缓存 key 的分隔符。key 的形状是 `<agentType>` + 这个字符 + `<cwd>`,由 skills.ts 的
 * cacheKey() 拼出来;落盘这边要按它把 cwd 拆回来判断目录还在不在,所以定义在这里给两边
 * 共用(反过来放 skills.ts 会让这个模块反向依赖它,变成一个环)。
 *
 * 用 fromCharCode 构造,**别在源码里敲真的 NUL** —— 那会让 git 把整份文件记成二进制,
 * diff / blame / 大多数阅读器全瞎(第 4 轮审查就是这么被挡在门外的:审查者根本打不开
 * 这个文件)。有没有踩回去,`test:skills` 里有一条钉子按字节查。
 */
export const KEY_SEP = String.fromCharCode(0);

export interface PersistedCalibration {
  names: string[];
  at: number;
}

/** 落盘的上限:够覆盖手头几个项目,又不会让这个文件无声长大。 */
const KEEP = 200;

export function loadCalibrations(): Map<string, PersistedCalibration> {
  const out = new Map<string, PersistedCalibration>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE(), "utf8"));
  } catch {
    return out; // 没有 / 坏了 = 当作没校准过,退回扫盘结果(degrade,不是报错)
  }
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<PersistedCalibration> | null;
    const names = Array.isArray(entry?.names)
      ? entry!.names.filter((n): n is string => typeof n === "string" && !!n)
      : [];
    if (!names.length || typeof entry?.at !== "number") continue;
    out.set(key, { names, at: entry.at });
  }
  return out;
}

/**
 * 跑过的目录没了(worktree 合并后被清掉)时,这条校准该落在哪个 key 上。
 *
 * **不能直接丢**:菜单是按项目根问的,而校准几乎都记在 `<repo>/.worktrees/<id>` 上、靠
 * 前缀认亲。直接丢 = 最后一个 worktree 被清掉时 `/compact` 又从菜单里消失,正好把这个
 * 模块存在的理由抵消掉。所以**上提到仍然存在的最近祖先**:那一层还在,就说明这份清单
 * 量的还是同一个项目。一路走到文件系统根都没活着的祖先,才是真的整棵树没了 → 丢。
 */
function reanchor(key: string): string | null {
  const at = key.indexOf(KEY_SEP);
  const cwd = at < 0 ? "" : key.slice(at + 1);
  if (!cwd) return key; // 没记 cwd 的老条目:留着,认亲那边自己会跳过
  if (existsSync(cwd)) return key;
  for (let dir = cwd; ; ) {
    const parent = dirname(dir);
    if (parent === dir) return null; // 走到根了
    if (existsSync(parent)) {
      // 只剩文件系统根还活着 = 这条已经认不出是哪个项目了,留着只会乱认亲
      return parent === dirname(parent) ? null : `${key.slice(0, at)}${KEY_SEP}${parent}`;
    }
    dir = parent;
  }
}

export function saveCalibrations(calibrations: Map<string, PersistedCalibration>): void {
  const alive = new Map<string, PersistedCalibration>();
  for (const [key, value] of calibrations) {
    const anchored = reanchor(key);
    if (!anchored) continue;
    const prev = alive.get(anchored);
    if (!prev || value.at > prev.at) alive.set(anchored, value); // 上提之后撞车:留新的那份
  }
  const sorted = [...alive].sort((a, b) => b[1].at - a[1].at);
  const file = FILE();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // 先写临时文件再改名:server 被杀在写一半上时,留下的是上一份完整的而不是半截 JSON。
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sorted.slice(0, KEEP)), null, 2));
    renameSync(tmp, file);
  } catch {
    // 盘满 / 只读挂载:校准退回「只活在内存里」的老行为,不该把这一轮 CLI 跑挂掉
  }
}

/** 只给测试用:连冷启动来源一起清掉(界面上的「重新扫描」不走这里,见 skills.ts)。 */
export function clearPersistedCalibrations(): void {
  rmSync(FILE(), { force: true });
}
