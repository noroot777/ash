// 「这家 CLI 会读哪几份配置、合起来最终生效的是哪一条」—— **读和判那一半**。
//
// 跟 `register.ts`(怎么把缺的那条补进去)分开住的理由:这一半有三个独立的消费者 ——
// 派审预检(`ash-mcp-file.ts`)、设置页与起跑自检、以及补接流程本身,而它们一律只许走这里
// 的 `readingFor` + `resolveAshMcp`(本轮审查 F2:启停策略原先只进了其中一处,同一份配置
// 在设置页上是「已接好」、在真 CLI 那边是 `Blocked`)。两个文件都已经接近单文件行数上限,
// 本轮按这条缝拆开。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileState } from "../auth/config-publish.js";
import { ashMcpConfigDir, ashMcpMechanism } from "./catalog.js";
import { ASH_MCP_NAMES, foldScan } from "./shapes.js";
import type {
  AshMcpConfigSite, AshMcpConfigState, AshMcpMechanism, AshMcpNameFact, AshMcpNameScan, AshMcpReading,
} from "./types.js";

/**
 * 「这家 CLI 的配置怎么读」—— **三个表面只许从这里取**(语义与病史见 `AshMcpReading`)。
 * 判定(`ash-mcp-file.ts`)、安装写入资格(`registerAshMcp`)、设置页与诊断文案全走它,
 * 所以逐家启停策略不可能只进其中一处。
 */
export function readingFor(mechanism: Extract<AshMcpMechanism, { kind: "file" }>): AshMcpReading {
  return {
    shape: mechanism.shape,
    merges: mechanism.site.sourcesMerge === true,
    ...(mechanism.switches ? { switches: mechanism.switches } : {}),
  };
}

/**
 * 这家 CLI 在**这个配置目录**里的配置文件。
 *
 * `alternates` 存在哪个就用哪个:用户已经有 `opencode.jsonc` 时再新建一份 `opencode.json`,
 * 两份都会被 CLI 认,到底哪份生效说不清(opencode / kilo 都认好几个文件名)。
 */
export function ashMcpConfigFile(dir: string, site: AshMcpConfigSite): string {
  // 实测过同目录加载序的家(`load`):落点取**存在的那几份里优先级最高的那个** —— 往更低
  // 那份写,写完会被上面那份盖掉(真 opencode:`.jsonc` 压 `.json` 压 `config.json`)。
  if (site.load) {
    const existing = site.load.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
    return existing.at(-1) ?? join(dir, ...site.relative);
  }
  for (const candidate of site.alternates ?? []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return join(dir, ...site.relative);
}

/**
 * **宿主机上这家 CLI 真正读的那份配置文件 —— 写、判、提示只认这一处。**
 *
 * `dirEnv` 指到文件的那几家(opencode 的 `OPENCODE_CONFIG`、kilo 的 `KILO_CONFIG`)必须原样
 * 用那个路径。本轮审查 R4:上一版只有这里认得它,另外三处消费者(预检的 `fileAshMcpVerdict`、
 * 启动自检的 `hostCliConfigFile`、自查文案的 `howToCheck`)各自先把文件名丢掉、再按默认名
 * 拼回来 —— 于是用自定义文件名的用户那边,真 CLI 连得上 ash、派审却报「没接好」,给出的
 * 路径还是另一份文件。声明了 `dirEnvIsFile` 之后不许任何消费者再自己恢复默认文件名。
 */
export function ashMcpHostFile(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  // 落点 = **优先级最高的那份可写来源**(见 `ashMcpHostSources`)。往更低优先级那份写,
  // 写完也可能被上面那份盖掉;只读来源(变量里那整段 JSON)当然不能当落点。
  const writable = ashMcpHostSources(agentType, env, home).filter((s) => s.file);
  return writable.at(-1)?.file ?? null;
}

/**
 * 一份「这家 CLI 会读的配置」。
 *
 * `level` 大的优先级高,**相等 = 谁覆盖谁没实测**,那时同名两份结论不一致一律判看不准。
 * 实测过加载序的那几家(站点上的 `sourcesMerge`)连同一个目录里的几个文件名都各占一级,
 * 所以它们永远不会出现相等的 level —— 判定走的是「几份合起来」,不是「挑一份赢家」。
 */
export interface AshMcpSource {
  /** 给人看的名字:文件路径,或 `$OPENCODE_CONFIG_CONTENT` 这样的变量名。 */
  readonly label: string;
  /** 可写落点;null = 只读来源(整段配置装在变量里,没有文件可写)。 */
  readonly file: string | null;
  /** 只读来源的正文。 */
  readonly text?: string;
  /**
   * 这份来源**证不出来**:路径算不出(相对路径而这一问没带 cwd)、内容也拿不到。
   * 一句给人看的原因。扫描直接答看不准 ⇒ 整体判定回 unknown(不拦人、不写),
   * 它也永远不会被选成写入落点(`file` 是 null)。
   */
  readonly unprovable?: string;
  readonly level: number;
}

/**
 * 这一层(某个配置目录)里**实际存在**的那几份,升序;一份都不存在时给出该写哪一份。
 *
 * 「该写哪一份」只有 `ashMcpConfigFile` 一份判据,所以 `alternates` 那一档把它挑中的那个
 * **排在最后** —— 上游 `ashMcpHostFile` 取的是最后一个,两边因此必然一致。按 existsSync 的
 * 自然顺序排会分叉:kilo 同时有 `config.json` 和 `opencode.jsonc` 时,`ashMcpConfigFile`
 * 取前者(alternates 的顺序就是我们猜的优先级),自然顺序的最后一个却是后者。
 *
 * `create = false` 给**额外目录**那一层(`extraDirs`):只枚举真实存在的,一份都没有就空着 ——
 * 那一层不是新建落点(ash 不替用户造第二个全局配置目录)。
 */
function filesInDir(dir: string, site: AshMcpConfigSite, create = true): string[] {
  // `load` 的顺序就是实测的加载序(升序),落点是其中存在的最高那份 —— 两边同一份判据,
  // 所以 `ashMcpHostFile` 取最后一个必然跟 `ashMcpConfigFile` 一致,不必再把它挪到末尾。
  if (site.load) {
    const found = site.load.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
    if (found.length) return found;
    return create ? [join(dir, ...site.relative)] : [];
  }
  const names = [site.relative, ...(site.alternates ?? [])];
  const found = names.map((parts) => join(dir, ...parts)).filter((f) => existsSync(f));
  const pick = ashMcpConfigFile(dir, site);
  if (found.length) return [...found.filter((f) => f !== pick), pick];
  return create ? [pick] : [];
}

/**
 * 这家 CLI 在宿主机上**会读的全部配置**,按优先级**从低到高**。
 *
 * 为什么不是一个文件,以及这个顺序凭什么(真 opencode 1.19.3 逐格实测,五轮):
 *  · `OPENCODE_CONFIG` 是「再加一份」不是「取代」—— 全局那份里的 ash 照样生效;
 *  · 默认目录里 `config.json` / `opencode.json` / `opencode.jsonc` **三份都读**,升序就是
 *    这个(上一版「找到第一个就只认它」,于是 ash 写在 `.json`、目录里又有一份 `.jsonc` 时
 *    判成 absent,安装器还往 `.jsonc` 里再补一条 —— 上一轮审查 F4 的第二格;`config.json`
 *    整个名字到本轮审查 F1 才补上,在那之前「只有 config.json 里有 ash」被判成 absent、
 *    派审硬拒,安装器还往更高优先级那份写一条、把真 CLI 的生效 `ASH_URL` 换掉了);
 *  · `~/.opencode/` 是**另一层全局配置**(`opencode.json` < `opencode.jsonc`),它压过默认
 *    目录、压过上面那个文件变量、也压过任务目录里的项目配置(本轮审查 F1 实测);
 *  · `OPENCODE_CONFIG_DIR` 是**再加一个目录**,优先级高于默认目录,**也高于上面那个文件**
 *    (本轮审查 F1 实测:文件里 `enabled: false`、这个目录里只写 `{"enabled": true}` ⇒
 *    真 CLI `ash connected`。上一版把文件排在它上面,于是这条连得上的登记被判成 disabled);
 *  · `OPENCODE_CONFIG_CONTENT` 里那整段 JSON 优先级最高、而且**没有文件可写** —— 只有它
 *    有 ash 时,真 CLI 连得上,上一版却判 absent 还去改全局文件(F4 的第三格)。
 *
 * 判「到底有没有」一律走 `resolveAshMcp`:这几份**合起来**CLI 最终看到的是哪一条。
 */
export function ashMcpHostSources(
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  cwd?: string,
): AshMcpSource[] {
  const mechanism = ashMcpMechanism(agentType);
  if (mechanism?.kind !== "file") return [];
  const { site } = mechanism;
  const out: AshMcpSource[] = [];
  // 实测过加载序的那几家(`sourcesMerge`),同一个目录里的几份也各占一级;没实测的那几家
  // 整层共用一级 —— 「相等 = 谁覆盖谁没实测」,见 `AshMcpSource.level`。
  const ordered = site.sourcesMerge === true;
  let next = 0;
  const addDir = (dir: string, create = true): void => {
    const files = filesInDir(dir, site, create);
    files.forEach((file, i) => out.push({ label: file, file, level: next + (ordered ? i : 0) }));
    next += ordered ? Math.max(files.length, 1) : 1;
  };
  // ① 配置目录那一层。`dirEnv` 指到**目录**时它整体取代默认目录(变量原样继承给子进程,
  //    CLI 认的就是它);指到**文件**时这一层仍是默认目录 —— 那种情况下不能走
  //    `ashMcpConfigDir`,它返回的是那个文件所在的目录,拿它拼只会又得到同一份,
  //    真正该一起看的全局那份照样看不见。
  const dirOverride = site.dirEnv && !site.dirEnvIsFile ? env[site.dirEnv]?.trim() : "";
  addDir(dirOverride || site.defaultDir(env, home));
  // ② 指到文件的变量。**同一个路径在两个阶段各算一次**(本轮审查 F1-B):上一版按 resolve
  //    后的路径去重、只保留第一次出现,于是 `OPENCODE_CONFIG` 指回默认目录里那份时,它那
  //    一次(优先级最高的)加载被整个删掉 —— 2026-10-31 实测:默认目录 `.json` 完整开着、
  //    同目录 `.jsonc` 只写 `{"enabled": false}`、`OPENCODE_CONFIG` 指回那份 `.json`,真
  //    CLI 最终是 `enabled: true`(`ash connected`),而去重之后 ash 判成 disabled、预检硬拒,
  //    落点还指向 `.jsonc`。文件身份相同不等于加载阶段相同,合并本身对同一份内容是幂等的。
  const file = site.dirEnvIsFile && site.dirEnv ? env[site.dirEnv]?.trim() : "";
  if (file) {
    // **相对路径按 CLI 自己的工作目录解**(2026-10-31 实测:同一个 `OPENCODE_CONFIG=work.json`
    // 在任务目录里跑读得出、在别处跑读不到)。给了 cwd 就解准;没给就**证不出来** ——
    // 那时既不能当「不存在」(absent 在派审里是硬拒),也不能当写入落点,如实答看不准。
    // 上一版把这个相对路径原样当文件路径,于是按 server 自己的目录去找、找不到就判 absent:
    // 真 CLI 那边 `ash connected`,预检当场拒了一整轮审查(本轮审查 F1)。
    const abs = isAbsolute(file) ? file : cwd ? resolve(cwd, file) : null;
    if (abs) out.push({ label: abs, file: abs, level: next++ });
    else {
      out.push({
        label: `$${site.dirEnv}=${file}`,
        file: null,
        unprovable: `$${site.dirEnv} 给的是相对路径 ${file}，它按 ${agentType} 自己的工作目录解 ——`
          + " 这一问没带上那个目录，所以算不出它指的是哪一份",
        level: next++,
      });
    }
  }
  // ③ 同样按固定路径算得出、这家也读的其它目录(opencode 的 `~/.opencode/`):**比上面那个
  //    文件高、比下面那个目录低**(实测,见 `AshMcpConfigSite.extraDirs`)。只枚举真实存在
  //    的那几份 —— 不拿它当新建落点,ash 不给用户造第二个全局配置目录。
  for (const extra of site.extraDirs ?? []) addDir(extra(env, home), false);
  // ④ 指到另一个配置目录的变量:再加一层,**比上面那些都高**(本轮实测)。
  const altDir = site.altDirEnv ? env[site.altDirEnv]?.trim() : "";
  if (altDir) addDir(altDir);
  // ⑤ 整段 JSON 装在变量里:优先级最高,**只读**。
  const inline = site.contentEnv ? env[site.contentEnv]?.trim() : "";
  if (inline) out.push({ label: `$${site.contentEnv}`, file: null, text: inline, level: next++ });
  return out;
}

/**
 * 一份来源扫出来的**逐名事实**(折叠和跨来源解析都建在它上面,见 `resolveAshMcp`)。
 *
 * 文件那一路先分清「没有这个文件」和「有但读不动」:下面的读取路径会把异常吞成「空」,
 * 于是一次 EACCES / EIO 会被说成「没有登记」,而 absent 是个会被用来拦人的结论
 * (`ash-mcp-reachability.ts` 的「向放行开」)。
 */
export function sourceScan(source: AshMcpSource, reading: AshMcpReading): AshMcpNameScan {
  // 证不出来的那一档(相对路径没带 cwd):看不准,别当成「没有」。
  if (source.unprovable) return { doubt: source.unprovable, names: new Map() };
  if (!source.file) {
    try {
      return reading.shape.scan(source.text ?? null, reading.switches);
    } catch (e) {
      return { doubt: `读里面的 ash MCP 登记失败：${(e as Error).message}`, names: new Map() };
    }
  }
  const probe = fileState(source.file);
  if (probe === "unreadable") return { doubt: "读不出来", names: new Map() };
  if (probe === "missing") return { missing: true, names: new Map() };
  try {
    return reading.shape.scan(readFileSync(source.file, "utf8"), reading.switches);
  } catch (e) {
    return { doubt: `读里面的 ash MCP 登记失败：${(e as Error).message}`, names: new Map() };
  }
}

/** 一份文件里的登记状态。 */
export function fileConfigState(file: string, reading: AshMcpReading): AshMcpConfigState {
  return sourceConfigState({ label: file, file, level: 0 }, reading);
}

/** 一份来源里的登记状态(= 扫一遍再折一下,折叠判据只有 `foldScan` 一份)。 */
export function sourceConfigState(source: AshMcpSource, reading: AshMcpReading): AshMcpConfigState {
  return foldScan(sourceScan(source, reading), source.label);
}

/** 最终生效的那条登记,外加**它来自哪一份来源 / 那条登记本身**(搬运和提示都消费这个)。 */
export interface AshMcpEffective extends AshMcpConfigState {
  /** present/disabled 时:说了算的那份来源。 */
  readonly source?: AshMcpSource;
  /** present/disabled 时:那条登记在它那份里的事实(原值 / 原文 / 启动方式都在这)。 */
  readonly fact?: AshMcpNameFact;
}

type NamePick = { name: string; fact: AshMcpNameFact; source: AshMcpSource } | { why: string };

/**
 * 几份来源合起来,这家 CLI **最终看到的**是哪一条登记,以及它出自哪一份。
 *
 * 判据(真 opencode 逐格实测):实测过合并语义的那几家走**逐字段合并** —— 同一个名字在几份
 * 来源里各有一条时,CLI 用的是它们按加载序合起来那一条,所以**状态和启动方式都从合完那份
 * 原值上重算**(本轮审查 F1)。上一版是「声明了这个名字的来源里,优先级最高的那份说了算」,
 * 三种形状都错:
 *  · 低的那份写完整登记、高的那份只写 `{"enabled": true}` ⇒ 真 CLI `ash connected`,而取
 *    赢家那一份得到的是「只有一个 enabled 键」的登记,搬进隔离档后那边一个工具都没有;
 *  · 来源层级本身排反了(见 `ashMcpHostSources` 的 ③)⇒ 一条连得上的登记被判成 disabled,
 *    预检当场硬拒,安装器还说是用户自己关的;
 *  · 同一层里两份都开着、命令不同时取的是数组里第一份,而真 CLI 用的是后面那份。
 *
 * 没实测过合并语义的家仍走老判据(最高那层说了算、同层不一致就看不准):猜「合并」会把没
 * 接上说成接上了,猜「取代」会把接上了说成没接上、还要再写一条顶掉它。
 *
 * **逐个兼容名各算一次**(上一轮审查 F3):`ash` 和 `harness` 是两条独立登记。更早一版先把
 * 每份来源压成一个四态结论、再按优先级选赢家,两个名字的事实在第一步就混成了一个 —— 于是
 * 「高优先级那份里 `ash` 关着、低优先级那份里 `harness` 开着」被判成 disabled(预检硬拒),
 * 而真 CLI 那边工具明明连得上。先按名字各自定下最终登记,再在这几条之上找开着的那条。
 *
 * 四处一律回 unknown(看不准就不写、也不拦起跑):
 *  · **这家的合并语义本身没实测**(`sourcesMerge` 不为真)而几份结论不一致 —— 那时「present」
 *    和「absent」各是一种猜,两种猜错的代价都是实打实的;
 *  · **同一层**里同一个名字有两份不一致的写法 —— 同层谁覆盖谁没实测(只会出现在没实测
 *    加载序的那几家身上);
 *  · 合完那条自己就认不出来(写法超出格式族认得的范围);
 *  · 有一份**整份读不准**、而且优先级不低于那条生效的登记 —— 它可能正把那条关掉。
 */
export function resolveAshMcp(
  sources: readonly AshMcpSource[],
  reading: AshMcpReading,
): AshMcpEffective {
  const { merges } = reading;
  if (!sources.length) return unknownState("算不出这家 CLI 会读哪几份配置");
  const read = sources.map((source) => ({ source, scan: sourceScan(source, reading) }));
  const folded = read.map((r) => foldScan(r.scan, r.source.label));
  // 格式族知道「这种写法怎么合」,站点知道「这家 CLI 到底会不会合」—— 两个都成立才真的合。
  const merge = merges ? reading.shape.mergeFacts : undefined;
  if (read.length > 1 && !merges && new Set(folded.map((f) => f.state)).size > 1) {
    return unknownState("这家 CLI 会读好几份配置，而它们的结论不一致、合并规则 ash 没实测过："
      + folded.map((f, i) => f.detail
        || (f.state === "present" ? `${read[i]!.source.label} 里已经有 ash 登记` : f.state)).join("；"));
  }
  const picks: NamePick[] = [];
  for (const name of ASH_MCP_NAMES) {
    // `read` 是升序的(见 `ashMcpHostSources`),所以这几份本身就是加载序。
    const declared = read.filter((r) => r.scan.names.has(name));
    if (!declared.length) continue;
    if (merge) {
      const fact = declared
        .map((r) => r.scan.names.get(name)!)
        .reduce((lower, higher) => merge(name, lower, higher));
      // 措辞和写入落点都指**优先级最高**的那份;合出来的结论跨了好几份时把它们都报出来。
      const source = declared.at(-1)!.source;
      const at = declared.length > 1 ? declared.map((r) => r.source.label).join(" + ") : source.label;
      if (fact.status === "doubt") picks.push({ why: `${at}：${fact.detail}` });
      else picks.push({ name, fact, source });
      continue;
    }
    const top = Math.max(...declared.map((r) => r.source.level));
    const winners = declared
      .filter((r) => r.source.level === top)
      .map((r) => ({ name, fact: r.scan.names.get(name)!, source: r.source }));
    const unsure = winners.find((w) => w.fact.status === "doubt");
    if (unsure) {
      picks.push({ why: `${unsure.source.label}：${unsure.fact.detail}` });
      continue;
    }
    if (new Set(winners.map((w) => w.fact.status)).size > 1) {
      picks.push({
        why: `同一层里好几份配置都写了 ${name} 这条登记、结论还不一致、谁覆盖谁 ash 没实测过（`
          + winners.map((w) => `${w.source.label}：${w.fact.status === "on" ? "开着" : "关着"}`).join("；") + "）",
      });
      continue;
    }
    // 同层、状态一致 ⇒ 取**写入落点那一份**(`filesInDir` 把它排在最后)。谁覆盖谁没实测,
    // 但指向落点至少跟 `ashMcpHostFile` 是同一份,不会出现「说的是 a、写的是 b」。
    picks.push(winners.at(-1)!);
  }
  const live = picks.find((p): p is Extract<NamePick, { name: string }> => "fact" in p && p.fact.status === "on");
  /**
   * 整份读不准的那些 —— **一份都不许放过**(本轮审查 F1-C)。
   *
   * 上一版只拦「优先级不低于生效那条」的,理由是「低的盖不住高的」。那条推理只覆盖了「某个
   * 字段会不会被覆盖」,漏掉了更粗的一档:2026-10-31 实测,真 opencode 读到**任何一份**读不
   * 通的配置就整份拒载(`debug config --pure` exit 1,报的是那份文件不是合法 JSON(C))——
   * 不管它在最低那层、最高那层、还是同目录那份 `.jsonc`,也不管它里面有没有提到 ash。
   * 那种情况下压根没有「生效的登记」可言,而上一版答的是 present、安装器还说「已经有生效的
   * ash 登记,不动它」:用户看到的是「已接好」,agent 起来一个工具都没有。
   *
   * 所以这里只要有一份读不准就答 unknown:不写(写进去也救不了那份坏文件)、不拦起跑、
   * 如实说是哪一份。同一份文件会在两个加载阶段各出现一次(见 `ashMcpHostSources` 的 ②),
   * 说给人听的时候按名字去重。
   */
  const blind = read.filter((r) => r.scan.doubt);
  const blindWhy = (over: typeof blind): string => [...new Set(
    over.map((b) => foldScan(b.scan, b.source.label).detail))].join("；");
  if (blind.length) {
    // 两种「看不准」分开说:**读不通**那种会让真 CLI 整份拒载,**证不出来**那种(相对路径
    // 没带工作目录)只是我们算不出它指的是哪一份 —— 混成一句会让用户去修一份其实好着的文件。
    const broken = blind.filter((b) => !b.source.unprovable);
    const vague = blind.filter((b) => b.source.unprovable);
    const why = [
      broken.length
        ? `${blindWhy(broken)} —— 这家 CLI 会读的配置里有读不准的那一份：它可能正把别处那条`
          + "登记关掉，也可能让这家 CLI 整份配置一起拒载（真 opencode 实测：任何一份读不通就起不来）"
        : "",
      vague.length ? `${blindWhy(vague)} —— 所以「别处都没有」这句也证不出来` : "",
    ].filter(Boolean).join("；");
    return unknownState(live ? `${live.source.label} 里有生效的 ${live.name} 登记，但 ${why}` : why);
  }
  if (live) return { state: "present", serverName: live.name, detail: "", source: live.source, fact: live.fact };
  const unsure = picks.filter((p): p is { why: string } => "why" in p);
  if (unsure.length) return unknownState(unsure.map((u) => u.why).join("；"));
  const off = picks.filter((p): p is Extract<NamePick, { name: string }> => "fact" in p);
  if (off.length) {
    return {
      state: "disabled",
      serverName: off[0]!.name,
      detail: off.map((o) => `${o.source.label}：${o.fact.detail}`).join("、"),
      source: off[0]!.source,
      fact: off[0]!.fact,
    };
  }
  // 一个名字都没声明 ⇒ 确实没有。措辞用**最后那份**(优先级最高的那份,也是写入落点)。
  return { ...folded.at(-1)!, source: read.at(-1)!.source };
}

/** `resolveAshMcp` 的四态投影(老调用方只要状态)。 */
export function effectiveConfigState(
  sources: readonly AshMcpSource[],
  reading: AshMcpReading,
): AshMcpConfigState {
  return resolveAshMcp(sources, reading);
}

/** 某个配置目录(隔离档给个人目录,宿主档走 `ashMcpHostFile`)里的那份配置文件。 */
export function siteFileFor(agentType: string, dir: string, site: AshMcpConfigSite, env: NodeJS.ProcessEnv): string {
  // 指到文件的变量只在**宿主档**成立:隔离档是我们自己造的目录,调用方给的 dir 才是权威。
  if (site.dirEnvIsFile && dir === ashMcpConfigDir(agentType, env, homedir())) {
    return ashMcpHostFile(agentType, env) ?? ashMcpConfigFile(dir, site);
  }
  return ashMcpConfigFile(dir, site);
}

/**
 * 同一个配置目录里这家 CLI 也会读、而这个格式族读不了的那种文件(trae 的原生 YAML)。
 * 返回第一个**真实存在**的;没有就 null。语义与两条后果见 `AshMcpConfigSite.opaque`。
 */
export function ashMcpOpaqueSibling(dir: string, site: AshMcpConfigSite): string | null {
  for (const candidate of site.opaque ?? []) {
    const file = join(dir, ...candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

/** 这家 CLI 的 ash MCP 登记状态(四态,语义见 `types.ts` 的 `AshMcpConfigState`)。 */
export function ashMcpStateIn(
  dir: string,
  agentType: string,
  env: NodeJS.ProcessEnv = process.env,
): AshMcpConfigState {
  const mechanism = ashMcpMechanism(agentType);
  if (!mechanism) return unknownState(`不认识的执行器 ${agentType}`);
  if (mechanism.kind === "none") return { state: "absent", serverName: null, detail: mechanism.why };
  if (mechanism.kind === "manual") {
    return unknownState(`${agentType} 的 MCP 配置 ash 不自动读写：${mechanism.howTo}`);
  }
  const file = siteFileFor(agentType, dir, mechanism.site, env);
  // 同目录有这家也读、而我们读不了格式的配置 ⇒ 不下结论(`AshMcpConfigSite.opaque`)。
  const opaque = ashMcpOpaqueSibling(dir, mechanism.site);
  if (opaque) return unknownState(`${opaque} 这份配置 ${agentType} 也读，而 ash 读不了它的格式`);
  // **先分清「没有这个文件」和「有但读不动」**:下面的读取路径会把异常吞成「空」,于是一次
  // EACCES / EIO 会被说成「没有登记」。absent 是个会被用来拦人的结论(`ash-mcp-reachability.ts`
  // 的「向放行开」),只有确实没有文件才配得上它。
  return fileConfigState(file, readingFor(mechanism));
}

const unknownState = (detail: string): AshMcpConfigState => ({ state: "unknown", serverName: null, detail });
