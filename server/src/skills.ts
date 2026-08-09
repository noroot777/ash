// 「这个 CLI 自己已经装了哪些技能」——供对话框/新建任务里的 `/` 补全用。
//
// 菜单仍只把 `/{名字}` 补进正文；运行前则用同一份扫描结果把命中的
// SKILL.md 精确路径注入 prompt。不能只指望 CLI/模型自己认 slash：harness 的无人
// 值守、完成协议等前言会排在任务正文前，`/skill` 已经不是 CLI 的首条命令。
//
// 三层取数(取数永远是全量,3ms 不值得做 diff 协议):
//  ① 全量扫盘 —— 唯一的取数方式,只在指纹对不上/强制刷新时发生
//  ② stat 指纹 —— 增量的是「判断」不是「数据」,一样就直接返缓存
//  ③ init 事件校准 —— claude 每次跑起来吐的第一行 JSON 白送权威清单,搭便车
//
// **绝不能为了拿清单主动跑一次 CLI**:实测那一下 haiku 就烧了 $0.084(66k tokens
// 的 cache creation)。它只能搭便车。
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type {
  AgentType,
  SkillEntry,
  SkillList,
  SkillScanOverview,
  SkillScanRow,
  SkillSource,
} from "@harness/shared";

// 扫得动的 CLI。其余 agentType 一律空表(degrade,不报错)。
const SCANNABLE = ["claude", "codex", "gemini"] as const;
type Scannable = (typeof SCANNABLE)[number];
const isScannable = (type: string): type is Scannable =>
  (SCANNABLE as readonly string[]).includes(type);

// init 的 `slash_commands` 比 `skills` 多一批**CLI 自己的**命令(clear/compact/model/
// heapdump…),它们在 headless 下要么无意义要么有害。所以这里用**白名单**而不是黑名单:
// 名单没跟上新版 CLI 的代价只是少露一个命令(静默 degrade),黑名单没跟上的代价却是
// 把 `/heapdump` 递到用户面前、他发出去白烧一轮。
const BUILTIN_SLASH_ALLOW = new Set(["review", "security-review"]);

interface Root {
  dir: string;
  source: SkillSource;
  /** 插件技能的命名空间前缀,如 `hyperframes:`。 */
  prefix: string;
}

interface WalkItem extends Root {
  name: string;
  skillFile: string;
  mtimeMs: number;
  size: number;
}

function claudePluginRoots(): Root[] {
  // 插件目录堆着历史版本(hyperframes 一家躺着 10 个版本目录),glob 一扫会把废弃版本
  // 全列出来 —— 必须读 installed_plugins.json 拿当前生效的 installPath。
  const file = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const plugins = (parsed as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  const roots: Root[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    if (!Array.isArray(value) || !value.length) continue;
    // 同一个插件可能列着多份(不同 scope/版本),取 lastUpdated 最新的那份。
    const live = [...(value as { installPath?: unknown; lastUpdated?: unknown }[])]
      .filter((entry) => typeof entry?.installPath === "string")
      .sort((a, b) => String(a.lastUpdated ?? "").localeCompare(String(b.lastUpdated ?? "")))
      .at(-1);
    if (!live) continue;
    roots.push({
      dir: join(live.installPath as string, "skills"),
      source: "plugin",
      prefix: `${key.split("@")[0]}:`,
    });
  }
  return roots;
}

function rootsFor(agentType: Scannable, cwd: string): Root[] {
  switch (agentType) {
    case "claude":
      return [
        { dir: join(cwd, ".claude", "skills"), source: "project", prefix: "" },
        { dir: join(homedir(), ".claude", "skills"), source: "user", prefix: "" },
        ...claudePluginRoots(),
      ];
    case "codex": {
      const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
      return [
        { dir: join(cwd, ".codex", "skills"), source: "project", prefix: "" },
        { dir: join(home, "skills"), source: "user", prefix: "" },
      ];
    }
    case "gemini":
      return [
        { dir: join(cwd, ".gemini", "skills"), source: "project", prefix: "" },
        { dir: join(homedir(), ".gemini", "skills"), source: "user", prefix: "" },
      ];
  }
}

// 目录 → 「有哪些 SKILL.md、各自多新」。**不读文件内容** —— 这一趟是指纹用的,
// 78 个技能 0.21 ms;真正贵的是读 frontmatter,只在指纹变了才做。
//
// 必须用 statSync 而不是 readdirSync(withFileTypes) + isDirectory():本机 78 个条目
// 里有 39 个是跨 CLI 共享的软链,dirent 认软链不认目录,会**静默漏掉一半**。
function walk(roots: Root[]): WalkItem[] {
  const items: WalkItem[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root.dir);
    } catch {
      continue; // 目录不存在 = 这个 CLI 没装技能,不是错误
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const skillFile = join(root.dir, name, "SKILL.md");
      try {
        const stat = statSync(skillFile); // 跟随软链
        if (!stat.isFile()) continue;
        items.push({ ...root, name, skillFile, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        continue; // 没有 SKILL.md 的目录不是技能
      }
    }
  }
  return items;
}

// 指纹必须**逐个 stat SKILL.md**:实测「改 SKILL.md 内容」根本不会改根目录 mtime,
// 只看根目录的话用户改了 description 菜单永远显示旧文案、而且永远不会自己好。
// 差价 0.2 ms,别省。
const fingerprintOf = (items: WalkItem[]) =>
  items
    .map((item) => `${item.skillFile}:${item.mtimeMs}:${item.size}`)
    .sort()
    .join("|") || "empty";

// frontmatter 只取前 2 KB 正则抠 name/description,不引 yaml 库。
function readFrontmatter(file: string): { name?: string; description?: string } {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return {};
  }
  let head: string;
  try {
    const buf = Buffer.alloc(2048);
    const read = readSync(fd, buf, 0, 2048, 0);
    head = buf.toString("utf8", 0, read);
  } catch {
    return {};
  } finally {
    closeSync(fd);
  }
  const opened = /^---\r?\n([\s\S]*)$/.exec(head);
  if (!opened) return {};
  // 正常情况取到闭合的 `---` 为止;description 超长把 2 KB 撑爆时没有闭合标记,
  // 那就拿手上这段将就(比返回空强)。
  const block = /^([\s\S]*?)\r?\n---/.exec(opened[1]!)?.[1] ?? opened[1]!;
  const field = (key: string) => {
    const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block)?.[1]?.trim();
    if (!raw) return undefined;
    const unquoted = /^(["'])([\s\S]*)\1$/.exec(raw)?.[2] ?? raw;
    return unquoted.trim() || undefined;
  };
  return { name: field("name"), description: field("description") };
}

interface Scan {
  fingerprint: string;
  entries: Omit<SkillEntry, "alsoIn">[];
}

// 分隔符用 NUL:路径里不可能出现它,cwd 带空格也不会串味。
const KEY_SEP = "\u0000";
const cacheKey = (agentType: string, cwd: string) => `${agentType}${KEY_SEP}${cwd}`;
const scanCache = new Map<string, Scan>();

function build(items: WalkItem[]): Omit<SkillEntry, "alsoIn">[] {
  const byCommand = new Map<string, Omit<SkillEntry, "alsoIn">>();
  for (const item of items) {
    const front = readFrontmatter(item.skillFile);
    // 目录名是权威的(CLI 按目录名认技能);frontmatter 的 name 只在没冲突时用来纠错。
    const name = `${item.prefix}${item.name}`;
    const command = `/${name}`;
    if (byCommand.has(command)) continue; // 先到先得:project > user > plugin
    let realPath: string | null = null;
    try {
      realPath = realpathSync(join(item.dir, item.name));
    } catch {
      realPath = null;
    }
    byCommand.set(command, {
      name,
      command,
      description: (front.description ?? "").replace(/\s+/g, " ").slice(0, 200),
      source: item.source,
      realPath,
    });
  }
  return [...byCommand.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scan(agentType: Scannable, cwd: string, force = false): Scan {
  const key = cacheKey(agentType, cwd);
  const items = walk(rootsFor(agentType, cwd));
  const fingerprint = fingerprintOf(items);
  const cached = scanCache.get(key);
  if (!force && cached && cached.fingerprint === fingerprint) return cached;
  const next: Scan = { fingerprint, entries: build(items) };
  scanCache.set(key, next);
  return next;
}

// ── 第三层:claude 的 init 事件校准 ────────────────────────────────────────
// 每次 claude 跑起来吐的第一行 JSON 带 `skills` / `slash_commands` 两个全量数组,
// 含插件技能和 `/review` 这类**根本不在磁盘上**的内置技能 —— 这是拿到它们的唯一渠道。
interface Calibration {
  names: string[];
  at: number;
}
const calibrations = new Map<string, Calibration>(); // key = cacheKey(agentType, 那一轮真实的 cwd)

export function calibrateSkills(
  agentType: AgentType,
  cwd: string,
  skills: unknown,
  slashCommands: unknown,
): void {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : [];
  const names = new Set(strings(skills));
  for (const command of strings(slashCommands)) {
    if (BUILTIN_SLASH_ALLOW.has(command)) names.add(command);
  }
  if (!names.size) return;
  calibrations.set(cacheKey(agentType, cwd), { names: [...names], at: Date.now() });
}

// 任务多半跑在 `<repoPath>/.worktrees/<id>` 里,而菜单是按项目问的 —— 所以按前缀认亲,
// 取最新的那次。认不到就用扫盘结果:degrade,不是空白。
function calibrationFor(agentType: AgentType, cwd: string): Calibration | null {
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  let best: Calibration | null = null;
  for (const [key, value] of calibrations) {
    const [type, ranIn] = key.split(KEY_SEP);
    if (type !== agentType || !ranIn) continue;
    if (ranIn !== cwd && !ranIn.startsWith(prefix)) continue;
    if (!best || value.at > best.at) best = value;
  }
  return best;
}

/** 只给测试和「手点重新扫描」用:清掉所有缓存与校准。 */
export function resetSkillCache(): void {
  scanCache.clear();
  calibrations.clear();
}

export function listSkills(opts: {
  agentType: string;
  cwd: string;
  force?: boolean;
  remote?: boolean;
}): SkillList {
  const agentType = opts.agentType as AgentType;
  const base: SkillList = {
    agentType,
    cwd: opts.cwd,
    fingerprint: "empty",
    authoritative: false,
    remote: !!opts.remote,
    skills: [],
  };
  // ssh 执行器扫的是本机磁盘,那不是它将要跑的地方 —— 宁可不显示,也不假装有。
  if (opts.remote || !isScannable(agentType)) return base;

  const self = scan(agentType, opts.cwd, opts.force);
  // 同一个技能常常跨 CLI 软链共享(本机 78 个条目去重后只有 54 个物理技能)。标一个
  // 「谁都能用」的角标,免得用户切一次执行器看见列表短了一半,以为技能丢了。
  const others = new Map<string, AgentType[]>();
  for (const other of SCANNABLE) {
    if (other === agentType) continue;
    for (const entry of scan(other, opts.cwd, opts.force).entries) {
      if (!entry.realPath) continue;
      const list = others.get(entry.realPath) ?? [];
      if (!list.includes(other)) list.push(other);
      others.set(entry.realPath, list);
    }
  }

  const skills: SkillEntry[] = self.entries.map((entry) => ({
    ...entry,
    alsoIn: entry.realPath ? others.get(entry.realPath) ?? [] : [],
  }));

  const calibration = calibrationFor(agentType, opts.cwd);
  if (calibration) {
    // **并集而不是交集**:init 补上磁盘看不见的(内置、插件),磁盘补上 init 之后新装的。
    // 取交集的话「加一个技能目录、不重启就该出现」这条就废了 —— 那份清单是上一轮跑的。
    const known = new Set(skills.map((skill) => skill.name));
    for (const name of calibration.names) {
      if (known.has(name)) continue;
      skills.push({
        name,
        command: `/${name}`,
        description: name.includes(":") ? "插件技能" : "CLI 内置技能",
        source: name.includes(":") ? "plugin" : "builtin",
        realPath: null,
        alsoIn: [],
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    ...base,
    fingerprint: self.fingerprint,
    authoritative: !!calibration,
    skills,
  };
}

/**
 * 把用户放在任意独立行开头的 `/{技能}` 变成确定调用。tasks.body 不改，只改本回合 prompt。
 * 只认当前执行器真实扫到的完整命令，所以正文中的路径和未安装名字不会被误改写。
 */
export function withSkillInvocation(opts: {
  agentType: string;
  cwd: string;
  text: string;
  remote?: boolean;
}): string {
  const available = new Map(listSkills(opts).skills.map((skill) => [skill.command, skill]));
  const selected = [...opts.text.matchAll(/(?:^|\n)[\t ]*(\/\S+)(?=\s|$)/g)]
    .map((match) => available.get(match[1]!))
    .filter((skill): skill is SkillEntry => !!skill)
    .filter((skill, index, all) => all.findIndex((candidate) => candidate.command === skill.command) === index);
  if (!selected.length) return opts.text;

  const lines = selected.map((skill) => skill.realPath
    ? `- ${skill.command}：开始其他工作前，必须完整读取并遵循 ${JSON.stringify(join(skill.realPath, "SKILL.md"))}。`
    : `- ${skill.command}：这是 ${opts.agentType} CLI 已报告可用的内置 skill，必须按该命令执行。`);
  const directive = `【已选择 skill】用户明确要求本回合调用下列 skill：\n${lines.join("\n")}`
    + `\n整段任务正文都是交给这些 skill 的任务上下文；不得把这些命令当作普通正文略过。`;
  return `${directive}\n\n${opts.text}`;
}

/** server 启动预热:把常用 CLI 的清单先扫进内存,免得第一次敲 `/` 等 IO。 */
export function warmSkills(cwds: string[]): void {
  for (const cwd of new Set(cwds)) {
    for (const agentType of SCANNABLE) {
      try {
        scan(agentType, cwd);
      } catch {
        // 预热失败无所谓,请求那一刻会重来
      }
    }
  }
}

/**
 * 设置页的「谁扫到了什么」:按 **CLI 类型 × 本机/远端** 归并后逐行给出条数与样本。
 *
 * 归并这一维的理由写在 `SkillScanRow` 的注释里(一句话:换供应商不会换出另一份技能)。
 * 这里只强调实现上的一条:归并键必须带上 remote —— 同一个 CLI 既注册了本机 profile
 * 又注册了 ssh profile 时,那是**两行**,不能让本机那份的条数替远端说话。
 */
export function scanOverview(opts: {
  cwd: string;
  executors: { label: string; agentType: string; remote: boolean }[];
  force?: boolean;
}): SkillScanOverview {
  const groups = new Map<string, { agentType: string; remote: boolean; executors: string[] }>();
  for (const executor of opts.executors) {
    const key = `${executor.agentType}|${executor.remote ? "ssh" : "local"}`;
    // 空 label = 调用方在「一个 profile 都没注册」时兜的那几行,没有名字可署。
    const named = executor.label ? [executor.label] : [];
    const group = groups.get(key);
    if (group) group.executors.push(...named);
    else groups.set(key, { agentType: executor.agentType, remote: executor.remote, executors: named });
  }

  const rows: SkillScanRow[] = [...groups.values()].map((group) => {
    const list = listSkills({
      agentType: group.agentType,
      cwd: opts.cwd,
      force: opts.force,
      remote: group.remote,
    });
    const bySource: Record<SkillSource, number> = { project: 0, user: 0, plugin: 0, builtin: 0 };
    for (const skill of list.skills) bySource[skill.source] += 1;
    return {
      agentType: list.agentType,
      remote: list.remote,
      executors: group.executors,
      scannable: isScannable(group.agentType),
      count: list.skills.length,
      bySource,
      sample: list.skills.slice(0, 6).map((skill) => skill.command),
    };
  });
  return { cwd: opts.cwd, scannedAt: new Date().toISOString(), rows };
}
