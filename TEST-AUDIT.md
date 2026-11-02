# 全量测试健康普查 — 当前 main(基点 `10d4b34d`)

> 纯审计产物:**没有修任何东西,没有改任何测试或产品代码**。全部 578 个叶子脚本真实执行,红的重跑一轮定稳定红/闪红。
> 执行日期 2026-11-02 · 基点 `10d4b34d` · 工作区 `.worktrees/1GYkm4-K_7zu`

## 摘要

| | |
|---|---|
| 入口脚本(root/server/web 的 `test` 与 `test:*`) | 384 条 |
| 拆开 `&&` 链后的去重叶子 | **578 条** |
| 其中落在验收门禁范围内 | 187 条 |
| 两轮都绿 | 537 |
| 闪红(基线红、单并发复核转绿) | 3 |
| **稳定红** | **38**(门禁内 7 / 门禁外 31) |
| 跳过 | 0(Windows 侧未执行,见 §2.4) |
| 范围外附加面(mcp 2 + mobile 8) | 8 绿 / 2 红,单独见第六章 |

**最要紧的一条**:门禁第 ① 步里的 #267 是稳定红,而 `scripts/accept-test.mjs` 在第一个失败步骤上 `process.exit` —— 于是第 ② 步「前端全量回归」**一条都不会跑**。这不是巧合性的红,是「谁也没见过完整测试健康面貌」的机制性原因。配合「门禁范围之外有一整片无人看管的测试」(38 条稳定红里 31 条在范围外,其中 3 条已红约六周),两者叠加解释了本次普查为什么必要。

**七条真缺陷**(产品/测试违反了被钉死的不变量):#397 浏览器授权窗口被插了 `await`、#208 代次助手被裸 `.set` 绕过、#481 一条测试会 SIGKILL 掉调用者的整个进程组,以及 #156/#157/#371/#491 这一族 —— 原生命令那条路不产出「启动回执」,于是接口回 409 说「尚未启动，请稍后重试」,而回合其实已经跑完了(机制见 T2,三处独立证据)。另有 7 条「待查」:失败形态无法用「测试陈旧」解释,但还没定位到机制。

**两条系统性问题**(不是单条红):源码文本扫描型测试与「单文件 700 行就拆」的硬规则正面冲突(T11,两条独立实例);扫宿主进程表的测试要求「测试窗口内本机没有其它同属主新进程」,这在任何有人在用的机器上都不成立(T12)。

**本次审计自己制造过三轮假红**,都已查明并修正,过程写在第三章 —— 它们的共性值得下一个做这件事的人先读一遍:执行器为了「更干净的隔离」施加的环境,本身就是被测行为的输入。

---

## 零 背景

- **基点**:`ash/1GYkm4-K` 分支的 worktree,HEAD `10d4b34d`(= 当时的 main)
- **执行日期**:2026-11-02
- **性质**:纯审计。**没有修改任何产品代码或测试代码**,下文每条问题只给归因与建议派单,不含修复。
- **缘起**:验收门禁在 2026-11-02 第一次真正全量执行回归就暴出基线红;此前历次门禁都在隔离判据上拒跑或被 skip,所以最近各笔合入的测试健康状况没人看过全貌。

---

## 一、测试面:它到底有多大

### 1.1 验收门禁实际跑哪些

项目的验收前置命令是根 `package.json` 的 `test:accept` = `node scripts/accept-test.mjs`。这个文件里的 `STEPS` 是一个 **JS 数组**,不是 npm 脚本,所以从 `package.json` 静态展开是看不到它的——必须读代码:

| 步 | 标签 | 命令 |
|---|---|---|
| ① | 后端核心回归 | `npm -w server run test:accept` |
| ② | 前端全量回归 | `npm run test:web` → `npm -w web run test` |

第一步红了当场 `process.exit`,**第二步根本不会跑**。它还会在传给子进程前主动删掉环境里的 `ASH_DB` / `ASH_RUNS_DIR`。

`server:test:accept` 自己又是四段链:`test:review` → `test:free-workflow` → `test:accept-merge` → `test:monitor-checkpoint-recovery`。

### 1.2 全量枚举

把 root / server / web 三个 `package.json` 里所有 `test` 与 `test:*` 脚本的 `&&` 链与 `npm run` 间接层递归展开、按命令去重:

| | 入口脚本 | 展开去重后的叶子 |
|---|---|---|
| root | 5 | 10 |
| server | 211 | 370 |
| web | 168 | 199 |
| **合计** | **384** | **578** |

叶子命令全部是 `tsx`(389 条)或 `node`(190 条),没有第三种形态。其中 **187 条在验收门禁范围内**,391 条在范围外。

> 门禁编排器自身(`node scripts/accept-test.mjs`,即 root 的 `test:accept`)**不计入也不单跑**:它的叶子已各自单列,单跑等于把整条链再跑一遍。
>
> 去重很有必要:最高重复度的叶子被 4 个不同入口引用(例如 `test-side-chat.ts` 同时挂在 `server:test:side-chat`、`web:test:side-chat`、`web:test`、`root:test:web` 下)。按入口数算会把同一条测试重复计 4 次。

逐条清单见本报告末尾的**表 A**(384 条入口,含门禁归属与结果)和**表 B**(578 条叶子,含门禁标记、结果、耗时、历次结果链)。

### 1.3 声明范围之外

用户声明的范围是 root/server/web。另外两处也有测试脚本,本报告**单列**不混入上面的口径:

| 工作区 | `test:*` 条数 | 说明 |
|---|---|---|
| `mcp` | 2 | `test:reconnect`、`test:read-transcript`,各自前置 `npm run build` |
| `mobile` | 8 | 需要 `mobile/node_modules`,worktree 里原本没有 |
| `shared` | 0 | 没有测试脚本 |

### 1.4 相邻的闸(不是 `test:*`,但属于同一道健康判断)

这些不在枚举口径里,但一并跑了,因为它们失败会让下游测试全部无从判断:

| 命令 | 内容 | 结果 |
|---|---|---|
| `npm -w shared run build` | `tsc -p` | **绿** |
| `npm -w web run build` | `check-conventions.mjs` + `tsc -b` + `vite build` | **绿** |
| `npm -w server run build` | `check-cleanup-evidence.mjs` + `tsc -p` | **绿** |
| `npm -w mcp run build` | `tsc -p` | **绿** |

即:类型层、两个约定检查脚本、前端打包,当前基点上全部通过。

---

## 二、方法与环境

### 2.1 环境搭建

worktree 原本没有 `node_modules`。按主仓那份逐条软链补齐,并把 `node_modules/@ash/*` 指回**本 worktree 自己**的 `shared`/`server`/`web`/`mcp`(用 `realpath` 核验过)——否则测的是主仓那份代码,整次审计白做。`shared` 通过 `exports` 直接暴露 `src/*.ts`,不需要先构建。

### 2.2 怎么跑

- **把 `&&` 链拆开,逐个叶子单独跑**。链式会在第一条红处截断,后面的全被遮住——这正是「历次门禁没看过全貌」的机制本身。
- 每个叶子一份独立的临时 `ASH_DB`(`scripts/tmp-db.ts` 的 `requireTmpDb` 没有它会直接 `exit(1)`)。
- 全量轮 4 并发;**所有非绿叶子再单并发重跑一遍**,用来区分稳定红与闪红——并行撞硬编码端口造成的假红(例如 `test-openai-converter.ts` 写死 54321)会在这一轮变绿。
- 单条超时 600s(复核轮 900s),超时单独记一档,不混进红。
- 日志逐条落盘在工作区(不进 `data/runs`)。

### 2.3 浏览器通道

web 的 DOM 回归走 **playwright + 系统 Chrome,`headless: true`,临时 profile**(见 `web/scripts/chrome-path.mjs`),即全局规范的**第 2 级**。

降级原因:这些回归用 `page.route` 拦下 API 或自起 server fixture,**不需要任何登录态**,所以第 1 级(扩展具名分组后台标签,带用户 cookie)提供不了额外能力,降到第 2 级没有任何损失。全程没有接管、复用或导航用户的普通标签,没有激活 Chrome 窗口,没有写操作。

### 2.4 Windows 覆盖未执行

按要求没有碰 `192.168.1.187` 那台真机。因此:

- `root:test:restart` 家族(8 条)**只跑了 macOS 侧**;
- 名字里带 `windows` 的那几条(`test-windows-restart.mjs`、`test-windows-detached.ts`、`test-openers-windows.ts`、`test-win-launch.ts`、`test-powershell-command.ts`、`test-user-shell-powershell.ts`)在 macOS 上跑的是它们各自的「非 win32 分支或纯函数断言」那一半,**不构成 Windows 行为覆盖**。
- 报告里这些条目的绿**不能读成「Windows 上也对」**。

---

## 三、方法论修正:本次审计自己制造的假红

这一节单列,因为它直接决定前面那些数字能不能信,也是给下一个做同类普查的人的提醒。**第一轮和第二轮的红绿口径都因此作废了**,最终数字全部以修正后的那一轮为准。

### 缺陷① `spawn(detached: true)` 让被测脚本当上进程组组长

我最初给每个叶子 `spawn(..., { detached: true })`,想的是跑完能连孙子进程一起收干净。后果是被测脚本成了**进程组组长**——而一批被测产品代码的职责恰恰是「杀干净同组子进程」(`test-project-commands.ts` 里就写着「无视 SIGTERM 的进程必须升级 SIGKILL 收干净」)。于是测试一执行到那一步就**把自己 SIGTERM 掉**,报 `exit=143`。

实测:`test-terminal-lifecycle.ts` 在 `detached` 下 `exit=143`、日志末尾却是一串 `passed`;去掉 `detached` 后退出码 0。

**已知受此影响的假红**:`test-project-commands`、`test-terminal-lifecycle`、`test-launch-abandon`。

**修法**:不再 `detached`——被测脚本必须和真实跑法(`npm run test:*`)一样继承调用方的进程组;超时改走 `pgrep -P` 递归收集 pid 树、从叶子往根逐个 SIGKILL。

### 缺陷② 全局设 `ASH_RUNS_DIR` 把产品的测试隔离闸打开了

这一条影响大得多,也更隐蔽。`server/src/executors/spawn.ts`:

```ts
export function guardAgentSpawn(bin: string): ChildProcess | null {
  if (!process.env.ASH_RUNS_DIR || process.env.ASH_ALLOW_REAL_AGENT === "1") return null;
  return failedChild(`测试隔离环境禁止启动真执行器 ${bin};…`);
}
```

它把「**`ASH_RUNS_DIR` 已设**」本身当作「我在测试隔离环境里」的判据,然后一律拒绝起执行器。这道闸是 2026-08-07 泄漏 19 个 Claude 回合之后加的,判据本身是合理的。

问题在我这边:我为了隔离给**每个**叶子都设了 `ASH_RUNS_DIR`。而相当一批测试**自己不设它**,并且**指望真的 spawn 出它们摆在 PATH 上的假 CLI**——照它们被记录的跑法(裸 `tsx scripts/test-X.ts`)那道闸本来是关着的。我一设,假 CLI 就起不来了,症状五花八门且都不像环境问题:

- 直接报出那句守卫文案(`test-worktree-recovery` 期望 `/工作目录不存在/`、`test-claude-relay-settings-live` 期望 `null`);
- 「假 claude 没被起起来」(`test-cli-overrides`);
- 假进程该写的文件不存在(`test-codex-mcp-turn-token` 的 `mcp-env.json`、`test-native-steer` 的 `sticky.pid`,都是 ENOENT);
- `process.kill` 收到 `undefined`(`test-reattach`——守卫返回的 `failedChild` 没有 pid);
- **以及两条 900s 稳定超时**:`test-detached-survival` / `test-controllable-detached`。守卫挡住 spawn ⇒ 假 agent 一行都没产出 ⇒ 夹具里 `consume(child, 6)` 永不 resolve ⇒ `keepAlive` 定时器把进程撑住不退。两轮 600s + 900s 全耗在这个自造的假象上。

实测(bare 环境,只设临时 `ASH_DB`):这四条 `test-worktree-recovery` / `test-detached-survival` / `test-controllable-detached` / `test-reattach` 全绿,用时 3s / 3s / 1s / 12s。

**修法**:改成 `--bare-env`——**只设临时 `ASH_DB`**(那是 `requireTmpDb` 的硬要求),`ASH_RUNS_DIR`、`ASH_UPLOADS_DIR`、`CI` 一个都不设。自己设 `ASH_RUNS_DIR` 的测试(走 `monitors-fixture` 等夹具的那些)仍然照原样受闸保护,所以这个口径**没有**放大烧真额度的风险。

### 缺陷③ 进程组归属:两种朴素写法各炸一次,正解是加一层 shield

修掉缺陷①之后我把 `detached` 直接去掉了,结果换成另一种炸法。两种写法的失败形态完全不同:

| 写法 | 谁是组长 | 产品代码做组杀时 | 症状 |
|---|---|---|---|
| `detached: true` **套在被测脚本上** | 被测脚本自己 | 把自己杀了 | `exit=143`(128+SIGTERM),日志末尾却写着 `passed` —— 假红 |
| **完全不 `detached`** | 本执行器的祖先 | 把执行器连哨兵外壳一起杀了 | 跑到第 9 条、第 21 秒,**整树消失、没有退出码** |

第二种那次,元凶后来查明是 **#481 `test-service-ports-script`**(详见归因 §4.3 与建议单 T13):它把一个未经 `> 0` 守卫的 pid(`pidIn` 读到还没落盘的 pidfile 时返回 `0`)喂进了组级信号,于是信号打到调用方的整个进程组。

**正解:把 `detached` 套在 `sh` 上,而不是套在被测脚本上。**

```js
spawn("sh", ["-c", `${leaf.cmd}\n__rc=$?; exit $__rc`], { detached: true, ... });
```

这样 `sh` 是组长、被测脚本是**组内非组长**——和 `npm run test:*` 下「测试继承调用方的组、组长是祖先」**完全同形**,忠实度不打折;而组杀的半径只到 shield,炸不到执行器。有个坑:命令后面必须再跟一条语句,否则 `sh` 会把自己 exec 优化掉,被测脚本又变成组长。已实测验证组形状(shield 的 `pid == PGID`,被测进程同组、非组长)。另外超时与收尾都补上 `killGroup`(只杀 shield 那一组)+ pid 树遍历两道。

### 这三条缺陷给下一个人的提醒

三条的共性是:**执行器为了「更干净的隔离」而施加的环境,本身就是被测行为的输入**。进程组归属和 `ASH_RUNS_DIR` 都不是中立的容器参数,产品代码会读它们并改变行为。给测试加隔离手段时,判据应当是「**和它被记录的跑法一致**」,而不是「我能想到的最隔离的跑法」。

前两条还有一个共同的恶劣之处:**失败形态都不像环境问题**。缺陷①表现为 `exit=143`,缺陷②表现为业务断言失败(「假 claude 没被起起来」)、文件 ENOENT、甚至两条 900 秒「挂住」。换句话说,任何人换一种跑法来做这件事,都会**先被自己的执行器骗一轮**,而且骗术看起来像真缺陷。本次审计前后作废了两整轮数据(`results.jsonl`、`verify.jsonl`),权威口径只有 `bare.jsonl` + `bareverify.jsonl`。

**另外如实记一笔我自己的操作失误**:我曾用 `node -e 'import("./.audit/run.mjs")'` 给执行器做"语法检查",而 `import` 即执行——它真的起了一轮全量 sweep。已立即 `pkill`,只污染了早已作废的 `results.jsonl`,权威的 `bare.jsonl` 未受影响(行数前后一致)。语法检查应当只用 `node --check`。

还有一条顺带的观察,与本次审计无关但同类:`test-detached-survival.ts` 的夹具把一个「server」**拼成模板字符串写进 `.mjs` 文件**再 `node --import tsx` 起来。那段代码里任何签名或行为漂移,`tsc` 一个字都查不到——这类夹具是类型层的结构性盲区,只有真跑才会暴露,而它一旦坏掉的表现是**挂住**而不是报错。
## 四、结果与归因

### 4.1 总账

| | 条数 |
|---|---|
| 叶子脚本总数 | 578 |
| 两轮都绿 | 537 |
| 闪红(基线红、复核轮单并发转绿) | 3 |
| **稳定红**(两轮都红) | **38** |
| 跳过 | 0(全部真实执行;Windows 侧未执行见 §2.4) |

537 + 3 + 38 = 578。表 B 抬头写的「绿 540」是**末轮口径**(把 3 条闪红算进绿),两个数都对,口径不同。

稳定红里 **7 条在验收门禁范围内**(#38 #43 #85 #122 #267 #281 #284),31 条在范围外。

### 4.2 非绿清单与归因

「稳」=两轮都红(稳定红);「闪」=两轮里有一轮绿。门禁列 ✓ 表示落在验收门禁范围内。

| # | 门禁 | 叶子 | 稳/闪 | 耗时 | 归因 | 责任笔 / 已有主 | 建议单 |
|---|---|---|---|---|---|---|---|
| 38 | ✓ | `test-remote-return.mjs` | 稳 (红→红) | 35s | 契约过时 | 测试末笔 9a2ff615(10-10) | T6 |
| 43 | ✓ | `test-monitor-wake.tsx` | 稳 (红→红) | 1s | 契约过时 | 测试末笔 27d7bd0a(10-28) | T6 |
| 85 | ✓ | `test-assistant-entry.mjs` | 稳 (红→红) | 23s | 契约过时 | 测试末笔 95d95489(09-09) | T6 |
| 122 | ✓ | `test-branch-acceptance.mjs` | 稳 (红→红) | 78s | 契约过时 | 测试末笔 af0f7437(09-08) | T6 |
| 267 | ✓ | `run-accept-gate-tests.mjs` | 稳 (红→红) | 93s | 契约过时 | ae69818f(10-26) ↔ 80a8a2c5/4441e44a/bb1aa507(10-27) | T1 |
| 284 | ✓ | `test-review-wait-storage.ts` | 稳 (红→红) | 11s | 待查 | 6bde853c(10-24) | T2b |
| 281 | ✓ | `test-review-ownership.ts` | 稳 (红→红) | 14s | 已有主 | 任务 Wv2NXsDKnFgC | — |
| 156 |  | `test-cli-command-startup.ts` | 稳 (红→红) | 1s | 真缺陷 | queue-seat.ts:282 + task-start-receipt.ts:22 + task-run.ts:244 | T2 |
| 157 |  | `test-cli-plan-scheduling.ts` | 稳 (红→红) | 2s | 真缺陷 | 同 #156 | T2 |
| 208 |  | `test-monitor-complete-gate.ts` | 稳 (红→红) | 4s | 真缺陷 | review-continuation.ts | T4 |
| 371 |  | `test-native-command-turn.ts` | 稳 (红→红) | 1s | 真缺陷 | 同 #156 | T2 |
| 397 |  | `test-browser-grant-timing.ts` | 稳 (红→红) | 1s | 真缺陷 | f716e83e(10-30) | T3 |
| 481 |  | `test-service-ports-script.ts` | 闪 (红→绿) | 18s | 真缺陷 | test-service-ports-script.ts:75-76 + test-service-ports-fixtures.ts:85 | T13 |
| 491 |  | `test-multi-user-run.ts` | 稳 (红→红) | 3s | 真缺陷 | 同 #156 | T2 |
| 257 |  | `test-branch-worktree-state.ts` | 稳 (红→红) | 2s | 契约过时 | 6bb6bdab(10-23) | T7 |
| 258 |  | `test-base-update-recovery.ts` | 稳 (红→红) | 35s | 契约过时 | 6bb6bdab(10-23) | T7 |
| 261 |  | `test-branch-plan-creation.ts` | 稳 (红→红) | 2s | 契约过时 | 6bb6bdab(10-23) | T7 |
| 320 |  | `test-handoff-capability.ts` | 稳 (红→红) | 4s | 契约过时 | 测试末笔 033d7be2(09-02) | T8 |
| 324 |  | `test-handoff-auth.ts` | 稳 (红→红) | 7s | 契约过时 | f19395a6(10-24) | T8 |
| 373 |  | `test-cli-overrides.ts` | 稳 (红→红) | 1s | 契约过时 | 5bca1ec3(10-16) | T10 |
| 399 |  | `test-session-lost.ts` | 稳 (红→红) | 1s | 契约过时 | 9efd0081(10-31) | T11 |
| 508 |  | `test-ash-mcp-reach.ts` | 稳 (红→红) | 1s | 契约过时 | 9efd0081(10-31) | T11 |
| 513 |  | `test-cli-commands-ui.mjs` | 稳 (红→红) | 40s | 契约过时 | 测试末笔早于相关前端改版 | T16 |
| 514 |  | `test-cli-goal-lifecycle-ui.mjs` | 稳 (红→红) | 40s | 契约过时 | 同上 | T16 |
| 516 |  | `test-chat-browser.mjs` | 稳 (红→红) | 24s | 契约过时 | 同上 | T16 |
| 535 |  | `test-task-sync.mjs` | 稳 (红→红) | 0s | 契约过时 | 验收前置命令那一轮 | T15 |
| 560 |  | `test-scm-race.mjs` | 稳 (红→红) | 40s | 契约过时 | 同上 | T16 |
| 571 |  | `test-git-workbench-review-fixes.mjs` | 稳 (红→红) | 19s | 契约过时 | abf768ff(09-17) | T17 |
| 574 |  | `verify-git-workbench-refresh-paths.mjs` | 稳 (红→红) | 34s | 契约过时 | abf768ff(09-17) | T17 |
| 576 |  | `verify-git-workbench-design.mjs` | 稳 (红→红) | 17s | 契约过时 | abf768ff(09-17) | T17 |
| 180 |  | `test-monitor-delivery-batch.ts` | 稳 (红→红) | 53s | 待查 | b6f37590(10-24) | T5 |
| 203 |  | `test-monitor-races.ts` | 稳 (红→红) | 8s | 待查 | e54376dd(10-24) | T5 |
| 322 |  | `test-handoff.ts` | 稳 (红→红) | 6s | 待查 | 测试末笔 8986a12c(10-17) | T8 |
| 406 |  | `test-holder-scan.ts` | 稳 (红→红) | 14s | 待查 | — | T19 |
| 480 |  | `test-service-ports.ts` | 稳 (红→红) | 18s | 待查 | — | T18 |
| 482 |  | `test-terminal-capacity.ts` | 稳 (红→红) | 13s | 待查 | — | T18 |
| 503 |  | `test-team-turn-artifacts.ts` | 稳 (红→红) | 1s | 待查 | server/src/team/lead-status.ts:46 | T14 |
| 195 |  | `test-monitor-end-condition.ts` | 闪 (红→绿) | 8s | 环境问题 | 测试自陈 | T9 |
| 475 |  | `test-project-commands.ts` | 稳 (红→红) | 6s | 环境问题 | 台子假设:测试窗口内本机不得有其它同属主新进程 | T12 |
| 484 |  | `test-launch-abandon.ts` | 闪 (红→绿) | 3s | 环境问题 | 时序 | T12 |
| 207 |  | `test-monitor-review-lifecycle.ts` | 稳 (红→红) | 2s | 已有主 | 疑同 Wv2NXsDKnFgC | — |

### 4.3 逐条明细

**#38 `web: test-remote-return.mjs`** — 契约过时・门禁内・稳定红
- 归因:web fixture/选择器过时:缺 /api/tasks/:id/notices 与 /api/events 路由桩。
- 责任笔:测试末笔 9a2ff615(10-10)　建议单:T6
- 日志:`.audit/logs/038-web-test-remote-return.log`(6.9 KB)

**#43 `web: test-monitor-wake.tsx`** — 契约过时・门禁内・稳定红
- 归因:断言用的正则对元素属性敏感,自动输入卡改折叠后节点属性漂移。
- 责任笔:测试末笔 27d7bd0a(10-28)　建议单:T6
- 日志:`.audit/logs/043-web-test-monitor-wake.log`(14.7 KB)

**#85 `web: test-assistant-entry.mjs`** — 契约过时・门禁内・稳定红
- 归因:等不到 .workspace-assistant-entry(10s 超时),该类名在后续前端改版中已不存在/改名。
- 责任笔:测试末笔 95d95489(09-09)　建议单:T6
- 日志:`.audit/logs/085-web-test-assistant-entry.log`(0.7 KB)

**#122 `web: test-branch-acceptance.mjs`** — 契约过时・门禁内・稳定红
- 归因:getByRole('alert') strict mode 命中 2 个元素——页面新增了第二条 alert(验收前置命令那条),选择器需收窄。
- 责任笔:测试末笔 af0f7437(09-08)　建议单:T6
- 日志:`.audit/logs/122-web-test-branch-acceptance.log`(0.9 KB)

**#267 `server: run-accept-gate-tests.mjs`** — 契约过时・门禁内・稳定红
- 归因:判据互撞:「借来的树里有安装记录认下的自有包必须克隆」(10-26 审查修)与「来源落在被冻结项目外即 external、link 即可」(10-27 三笔审查修)互相抵消,provideDependency 返回 link 而断言要 clone。
- 责任笔:ae69818f(10-26) ↔ 80a8a2c5/4441e44a/bb1aa507(10-27)　建议单:T1
- 日志:`.audit/logs/267-server-run-accept-gate-tests.log`(6.6 KB)

**#281 `server: test-review-ownership.ts`** — 已有主・门禁内・稳定红
- 归因:续跑租约被对账器提前结算成 outcome:'failed'(期望 null);本轮确认复现。
- 责任笔:任务 Wv2NXsDKnFgC　建议单:—
- 日志:`.audit/logs/281-server-test-review-ownership.log`(6.5 KB)

**#284 `server: test-review-wait-storage.ts`** — 待查・门禁内・稳定红
- 归因:等待所有权落库后读回 `pending` 得 `undefined`(期望 `false`)。**与 #156 那一族无关**(它不走启动回执那条路),疑似 10-24 那轮 review 所有权改造留下的字段形状缺口,与 #281 同族。
- 责任笔:6bde853c(10-24)　建议单:T2b
- 日志:`.audit/logs/284-server-test-review-wait-storage.log`(1.9 KB)

**#156 `server: test-cli-command-startup.ts`** — 真缺陷・稳定红
- 归因:全新任务、干净库,**首次** POST /tasks/:id/run 就 409 而非 202。机制已定位:启动回执缺失:409 来自 `queue-seat.ts:282`「任务未通过启动检查，尚未启动，请稍后重试」,而那一句**只在 `waitForStartReceipt` 解析为 false 时**发出;`task-start-receipt.ts:22` 的回执只有在 `adoptRun(handle)` → `acknowledgeStartReceipt` 在起跑作用域内跑过才算有 —— 也就是**只有真 agent handle 被消费循环接手**才算。原生命令(`/status` 这类)在 `task-run.ts` 走到 `trackRun`(:244)之前就收口了,于是回合确实跑了、也确实按预期落了 failed,HTTP 那一侧却回 409 说「尚未启动」。日志里没有 `[ash] 任务 … 启动异常`,证明 `start()` 没抛,是**正常返回但没人发回执**。 用户可感知后果:在界面上给任务发一条带参数的 `/status`,看到的是「任务未通过启动检查，尚未启动，请稍后重试」,而不是真正的原因「/status 不接受参数」。本轮单独复跑一次原样复现(409 at :97,首次 run)。
- 责任笔:queue-seat.ts:282 + task-start-receipt.ts:22 + task-run.ts:244　建议单:T2
- 日志:`.audit/logs/156-server-test-cli-command-startup.log`(0.6 KB)

**#157 `server: test-cli-plan-scheduling.ts`** — 真缺陷・稳定红
- 归因:任务停在 `running` 没到 `done` —— 同一条路的另一面:没发回执那一侧也没把占位还回来。
- 责任笔:同 #156　建议单:T2
- 日志:`.audit/logs/157-server-test-cli-plan-scheduling.log`(0.8 KB)

**#180 `server: test-monitor-delivery-batch.ts`** — 待查・稳定红
- 归因:「补偿结果实际进入执行器 stdin」等不到;与 #203 同属哨兵投递族。
- 责任笔:b6f37590(10-24)　建议单:T5
- 日志:`.audit/logs/180-server-test-monitor-delivery-batch.log`(19.4 KB)

**#195 `server: test-monitor-end-condition.ts`** — 环境问题・闪红
- 归因:**闪红**(4 并发红、复核轮单并发 8 秒转绿),与断言自陈一致:「四轮都没能让那一行赶在收尾之前送出去 —— 台子前提不成立,不是产品问题」。台子靠反复竞速去凑前提,机器一忙就凑不出来。
- 责任笔:测试自陈　建议单:T9
- 日志:`.audit/logs/195-server-test-monitor-end-condition.log`(0.8 KB)

**#203 `server: test-monitor-races.ts`** — 待查・稳定红
- 归因:待交付哨兵结果让结算侧把任务判成「还有话要说」;批量兼容那笔之后的回归。
- 责任笔:e54376dd(10-24)　建议单:T5
- 日志:`.audit/logs/203-server-test-monitor-races.log`(0.9 KB)

**#207 `server: test-monitor-review-lifecycle.ts`** — 已有主・稳定红
- 归因:审查轮停在 'failed' 而非 'reviewing',与 #281 同一形状(提前结算),建议并入同一主。
- 责任笔:疑同 Wv2NXsDKnFgC　建议单:—
- 日志:`.audit/logs/207-server-test-monitor-review-lifecycle.log`(0.5 KB)

**#208 `server: test-monitor-complete-gate.ts`** — 真缺陷・稳定红
- 归因:裸 .set({ resumePrompt: null, updatedAt: now() }) 绕过 task-resume-prompt.ts 的代次助手,会漏掉代次——正是该测试 F1-A 钉的那一条。
- 责任笔:review-continuation.ts　建议单:T4
- 日志:`.audit/logs/208-server-test-monitor-complete-gate.log`(3.5 KB)

**#257 `server: test-branch-worktree-state.ts`** — 契约过时・稳定红
- 归因:错误文案漂移:期望 /git worktree repair/,实得「目标分支 … 已在另一个 worktree … 检出；未运行验收前置命令」。
- 责任笔:6bb6bdab(10-23)　建议单:T7
- 日志:`.audit/logs/257-server-test-branch-worktree-state.log`(0.9 KB)

**#258 `server: test-base-update-recovery.ts`** — 契约过时・稳定红
- 归因:同上一笔引入,基线更新恢复路径的断言未跟着验收前置命令改口径。
- 责任笔:6bb6bdab(10-23)　建议单:T7
- 日志:`.audit/logs/258-server-test-base-update-recovery.log`(2.7 KB)

**#261 `server: test-branch-plan-creation.ts`** — 契约过时・稳定红
- 归因:建分支计划读回 null(期望 'feature-x'),同一笔的字段/时序变更。
- 责任笔:6bb6bdab(10-23)　建议单:T7
- 日志:`.audit/logs/261-server-test-branch-plan-creation.log`(0.8 KB)

**#320 `server: test-handoff-capability.ts`** — 契约过时・稳定红
- 归因:「codex 标了 probe,清单却和内置快照一模一样」——probe 结果与内置快照已趋同,断言用的是 notDeepStrictEqual,语义上只要两者相等就红。
- 责任笔:测试末笔 033d7be2(09-02)　建议单:T8
- 日志:`.audit/logs/320-server-test-handoff-capability.log`(0.7 KB)

**#322 `server: test-handoff.ts`** — 待查・稳定红
- 归因:「只有 findRollout 定位得到的 codex 会话算迁移成功」2 !== 1:多出一条被判成功的会话。
- 责任笔:测试末笔 8986a12c(10-17)　建议单:T8
- 日志:`.audit/logs/322-server-test-handoff.log`(0.6 KB)

**#324 `server: test-handoff-auth.ts`** — 契约过时・稳定红
- 归因:远程提问被 409「审查所属的原目标方向已失效，旧收尾不再修改目标」拦下;该闸是 10-24 审查所有权绑定新加的,测试台子(末笔 09-10)没带方向身份。
- 责任笔:f19395a6(10-24)　建议单:T8
- 日志:`.audit/logs/324-server-test-handoff-auth.log`(0.5 KB)

**#371 `server: test-native-command-turn.ts`** — 真缺陷・稳定红
- 归因:「这一回合确实由本次调用接管了(错误落在时间线上,不是「没送出去」)」false —— **独立第三处证据**:原生命令这条路没有「接管回合」这个事实,正是因为它不产出启动回执。
- 责任笔:同 #156　建议单:T2
- 日志:`.audit/logs/371-server-test-native-command-turn.log`(0.5 KB)

**#373 `server: test-cli-overrides.ts`** — 契约过时・稳定红
- 归因:该笔让 claude.ts 无条件注入 Monitor 钩子的 --settings,而测试钉的是「没配覆盖项就不该多出一截参数」;测试自 08-21 未动,这笔也没同步它。
- 责任笔:5bca1ec3(10-16)　建议单:T10
- 日志:`.audit/logs/373-server-test-cli-overrides.log`(1.2 KB)

**#397 `server: test-browser-grant-timing.ts`** — 真缺陷・稳定红
- 归因:在「读浏览器授权 → spawn」窗口里插了 await assertReviewTurnStart(),破掉测试钉死的不变量:该窗口只许有撤回那一个 await。后果是用户在这段 await 里收回浏览器授权拦不住,首条消息仍写着已授权。fresh run(task-run.ts)那一路仍绿,只有续聊/召唤(orchestrator.ts)破。
- 责任笔:f716e83e(10-30)　建议单:T3
- 日志:`.audit/logs/397-server-test-browser-grant-timing.log`(3.9 KB)

**#399 `server: test-session-lost.ts`** — 契约过时・稳定红
- 归因:测试按文件名扫 orchestrator.ts 的源码文本找 affectedCodexResumeVersion,而该笔把它拆进了 turn-session-pick.ts;行为未丢。属「源码文本扫描型测试 vs 700 行拆分规则」的结构性冲突。
- 责任笔:9efd0081(10-31)　建议单:T11
- 日志:`.audit/logs/399-server-test-session-lost.log`(1.1 KB)

**#406 `server: test-holder-scan.ts`** — 待查・稳定红
- 归因:5 项未通过:「行上的名单是 null —— 结构化责任在换快照那一步丢了」「重试把账销了,而那个孩子还在写」。**两轮都红,排除并发**;这两句描述的是换快照时丢了结构化责任、以及销账早于孩子停写,倾向真缺陷。
- 责任笔:—　建议单:T19
- 日志:`.audit/logs/406-server-test-holder-scan.log`(6.2 KB)

**#475 `server: test-project-commands.ts`** — 环境问题・稳定红
- 归因:**两轮都红,所以不是并发污染 —— 这一条我先前归因错了,在此更正。** 4 并发那轮它报的孤儿是 pid 43703/43276,我当时判成「捞到了审计自己的进程」;复核轮**单并发**下它照样红,报的是 pid 86833/86832 —— 那个号段紧邻几分钟前观察到的、属于另一个 worktree 会话(2RYxjmZYUBWi)的 shell(pid 86852),所以更可能是本机其它无关会话的进程(等我去查时它们已退出,无法最终证明归属)。真正的判据写在 notice 自己的文本里:「同属主 + 出生在这次启动之后 + 环境里没有这次的记号 + 工作目录也核不上」。产品的处理是**如实上报而不是杀**(这一点是对的),但测试断言要求 notice 必须为空,等于假设「测试窗口内本机没有任何其它同属主的新进程」—— 这个假设在任何有人在用的开发机上都不成立,ash 服务自己起的进程也算。
- 责任笔:台子假设:测试窗口内本机不得有其它同属主新进程　建议单:T12
- 日志:`.audit/logs/475-server-test-project-commands.log`(2.0 KB)

**#480 `server: test-service-ports.ts`** — 待查・稳定红
- 归因:「等不到:它走了之后,活号跟着销」(`test-service-ports-fixtures.ts:79` 的 waitFor 超时)。**两轮都红,排除并发**:进程走了而「活号」没跟着销,要判是产品没销还是台子等错了对象。
- 责任笔:—　建议单:T18
- 日志:`.audit/logs/480-server-test-service-ports.log`(0.5 KB)

**#481 `server: test-service-ports-script.ts`** — 真缺陷・闪红
- 归因:**闪红,但失败形态是破坏性的 —— 正因为是竞速才更该修**(复核轮单并发 18 秒转绿,佐证了下面那个「pidfile 还没落盘」的竞速窗口)。**它会 SIGKILL 掉自己的进程组**(本轮实证:sig=SIGKILL、日志 0 字节;无 shield 时把整个审计 runner 树一起带走、无退出码)。机制:`pidIn = (f) => Number(readFileSync(f,"utf8").trim())` 在 pidfile 还没落盘时得 0;:75-76 读 litePid 时**没加 >0 守卫**,而紧邻的 :77 给 liteWorkerPid 加了 `waitFor(() => pidIn() > 0)` —— 这个不对称就是线索,它前面那个 waitFor 只等「端口听上了」,不等 pidfile 落盘。pid 0 进了任何组级信号就打到调用方的整个进程组。产品侧已排除:terminal-stop-script.ts:163 的 runStopScript 用 `detached: !IS_WINDOWS`,用户停止脚本本来就在独立进程组。按文档跑法 `npm run test:service-ports-script` 会 SIGKILL 掉调用者的 shell 和 npm。
- 责任笔:test-service-ports-script.ts:75-76 + test-service-ports-fixtures.ts:85　建议单:T13
- 日志:`.audit/logs/481-server-test-service-ports-script.log`(0.0 KB)

**#482 `server: test-terminal-capacity.ts`** — 待查・稳定红
- 归因:终端容量计数 17 !== 16,差一。**两轮都红,排除并发**(单并发下没有别的叶子占终端),所以是容量会计本身多算/少算了一个,倾向真缺陷。
- 责任笔:—　建议单:T18
- 日志:`.audit/logs/482-server-test-terminal-capacity.log`(0.7 KB)

**#484 `server: test-launch-abandon.ts`** — 环境问题・闪红
- 归因:**闪红**:4 并发红、复核轮单并发 3 秒转绿。「闲置回收不许杀用户签字接手的进程」这条判据依赖进程存活时序,机器一忙就偶发。
- 责任笔:时序　建议单:T12
- 日志:`.audit/logs/484-server-test-launch-abandon.log`(0.9 KB)

**#491 `server: test-multi-user-run.ts`** — 真缺陷・稳定红
- 归因:409「任务未通过启动检查，尚未启动，请稍后重试」—— 与 #156 命中同一行(`queue-seat.ts:282`),第二处独立证据。
- 责任笔:同 #156　建议单:T2
- 日志:`.audit/logs/491-server-test-multi-user-run.log`(0.7 KB)

**#503 `server: test-team-turn-artifacts.ts`** — 待查・稳定红
- 归因:`TypeError: __name is not a function`,发生在模块加载期(team/session.ts:624 → team/session-consumer.ts:91 → lead-status.ts:46)。这是 esbuild/tsx keepNames 助手没注入到那个作用域的形态,不是业务断言失败 —— 要先判定是源码里某个语法踩了 tsx 的坑,还是工具链版本问题。
- 责任笔:server/src/team/lead-status.ts:46　建议单:T14
- 日志:`.audit/logs/503-server-test-team-turn-artifacts.log`(0.8 KB)

**#508 `server: test-ash-mcp-reach.ts`** — 契约过时・稳定红
- 归因:断言用正则 `/if \(!existsSync\(cwd\)\)[\s\S]{0,400}?taskWorkspace\(/` 扫 orchestrator.ts 源码文本,而那段逻辑已被同一笔拆进 turn-workspace-pick.ts —— 日志里 actual 甚至原样打出了新文件的注释「目录没了怎么办、还在又要刷什么,都在 turn-workspace-pick.ts」和 pickTurnWorkspace 调用。**这是 T11 的第二个独立实例**,与 #399 同因。
- 责任笔:9efd0081(10-31)　建议单:T11
- 日志:`.audit/logs/508-server-test-ash-mcp-reach.log`(16.6 KB)

**#513 `web: test-cli-commands-ui.mjs`** — 契约过时・稳定红
- 归因:playwright 等不到 `getByRole('textbox', { name: '回复任务' })`,30s 超时 —— 可访问名漂移或该入口已改。
- 责任笔:测试末笔早于相关前端改版　建议单:T16
- 日志:`.audit/logs/513-web-test-cli-commands-ui.log`(1.2 KB)

**#514 `web: test-cli-goal-lifecycle-ui.mjs`** — 契约过时・稳定红
- 归因:`page.waitForResponse` 30s 超时(等不到约定的那个响应),目标接口形状或触发路径已变。
- 责任笔:同上　建议单:T16
- 日志:`.audit/logs/514-web-test-cli-goal-lifecycle-ui.log`(0.3 KB)

**#516 `web: test-chat-browser.mjs`** — 契约过时・稳定红
- 归因:等不到 `getByRole('heading', { name: '创建一个聊天空间' })`,12s 超时 —— 文案或节点角色已改。
- 责任笔:同上　建议单:T16
- 日志:`.audit/logs/516-web-test-chat-browser.log`(0.5 KB)

**#535 `web: test-task-sync.mjs`** — 契约过时・稳定红
- 归因:实际多出 `acceptGateRunning: true` 字段,期望里没有 —— 前端同步契约没跟上验收前置命令新加的那个状态位。
- 责任笔:验收前置命令那一轮　建议单:T15
- 日志:`.audit/logs/535-web-test-task-sync.log`(1.2 KB)

**#560 `web: test-scm-race.mjs`** — 契约过时・稳定红
- 归因:等不到 `getByRole('button', { name: '刷新 git 状态' })`,30s 超时 —— 按钮可访问名已改。
- 责任笔:同上　建议单:T16
- 日志:`.audit/logs/560-web-test-scm-race.log`(0.5 KB)

**#571 `web: test-git-workbench-review-fixes.mjs`** — 契约过时・稳定红
- 归因:「历史 list must actually scroll」—— 与 #574/#576 同族:底部多了 26px 全局状态栏,可滚区域的前提变了。
- 责任笔:abf768ff(09-17)　建议单:T17
- 日志:`.audit/logs/571-web-test-git-workbench-review-fixes.log`(1.3 KB)

**#574 `web: verify-git-workbench-refresh-paths.mjs`** — 契约过时・稳定红
- 归因:「mobile staged selection button must fit viewport height」:按钮 bottom 1130 超出视口 —— 同一个 26px 挤压。
- 责任笔:abf768ff(09-17)　建议单:T17
- 日志:`.audit/logs/574-web-verify-git-workbench-refresh-paths.log`(1.3 KB)

**#576 `web: verify-git-workbench-design.mjs`** — 契约过时・稳定红
- 归因:断言 workbench 必须恰好填满视口 `{0,0,1440,1000}`,实测 height=**974**(差 26px)。viewport 是 `newPage({viewport:{1440,1000}})` 显式设的,所以不是浏览器通道问题:底部那 26px 是 `abf768ff`(09-17)引入的全局状态栏。三条 git-workbench 布局测试末笔分别停在 09-15/09-16,**比状态栏早一两天**,之后再没动过 —— 已经红了约六周,因为它们在门禁范围外,没人看见。
- 责任笔:abf768ff(09-17)　建议单:T17
- 日志:`.audit/logs/576-web-verify-git-workbench-design.log`(0.6 KB)

## 五、建议派单

优先级口径:**P0** = 卡住验收门禁本身(不修就没人能验收任何任务);**P1** = 产品违反了测试钉死的不变量,用户可感知;**P2** = 测试契约过时,红绿信号失真但产品行为未必错;**P3** = 台子/环境问题。

一条红对应哪张单见 §4.2 的「建议单」列。拆单原则:**同一笔责任提交引入的红并进一张单**(改口径时要一起看),跨模块的不合并。

### P0 — 不修则门禁永远过不去

**T1 验收门禁依赖借用:两条审查判据互撞,拆掉一条**
- 范围:`server/src/accept-gate-deps.ts`(`recordedLinks` 的 owned/external/unknown 三态与 `provideDependency` 的 link/clone 决策)、`server/scripts/test-accept-gate-borrow.ts`
- 要做的判断:`ae69818f`(10-26)钉的是「借来的树里有安装记录认下的自有包时必须克隆,否则收口无处可写」;`80a8a2c5`/`4441e44a`/`bb1aa507`(10-27 第三轮独立审查)钉的是「来源落在被冻结项目之外就是 external,link 即可」。合成后的同一布局(owner 的 `node_modules/aliased -> ../packages/lib` + 手写 `.package-lock.json` 的 `link:true`,consumer 的 `node_modules` 软链到 owner)两条判据给出相反答案。**必须由人裁定哪一条是真口径**,然后改另一侧——两边都是审查结论,不能默认后者赢。
- 影响面:`run-accept-gate-tests.mjs` 在门禁第 ① 步内,它红 → `accept-test.mjs` 当场 `process.exit`,第 ② 步前端全量回归**一条都不会跑**。这正是「门禁长期没真跑过」的机制性原因。

### P1 — 产品违反不变量

**T3 浏览器授权窗口回归:把 `assertReviewTurnStart` 挪出授权窗口**
- 范围:`server/src/orchestrator.ts`(续聊/召唤那一路)
- 事实:`f716e83e`(10-30)在「读浏览器授权 → spawn」之间插了 `await assertReviewTurnStart(...)`。该窗口的不变量是「只许有撤回那一个 await」,理由写在测试注释里:排在授权之后的任何 await,用户在这段时间收回授权都拦不住,撤销已落库而首条消息仍写着已授权(来源:第 6 链第 1 轮审查 P1)。`task-run.ts`(fresh run)那一路仍绿,只有 orchestrator 这一路破。
- 验收判据:`test-browser-grant-timing.ts` 转绿,且 `f716e83e` 本来要修的那件事(spawn 之后的审查撤回不再报「一个字没送出去」)不回退。

**T4 代次助手被绕过:`review-continuation.ts` 改用 `task-resume-prompt.ts` 的 patch 助手**
- 范围:`server/src/review-continuation.ts` 的 `.set({ resumePrompt: null, updatedAt: now() })`
- 事实:那三列只许由 `task-resume-prompt.ts` 导出的 patch/条件助手写,裸 `.set` 会漏掉代次——`test-monitor-complete-gate.ts` 的 F1-A 钉的就是这一条,它现在把这处裸写点原样列了出来。
- 注:这是检查型断言(扫源码找裸 `.set`),所以**修法只有一种**:换成助手,不能靠改断言绕过。

**T5 哨兵投递族:补偿结果进不了执行器 stdin / 结算侧误判「还有话要说」**
- 范围:`server/scripts/test-monitor-delivery-batch.ts`(#180)、`test-monitor-races.ts`(#203);嫌疑笔 `b6f37590`、`e54376dd`(均 10-24,批量兼容待投递结果那一轮)
- 两条症状:① 补偿结果等不到真的进入执行器 stdin;② 待投递结果让结算侧把任务判成「还有话要说」。需要先判定是产品回归还是台子假设过时。

**T2 原生命令那条路不产出「启动回执」,于是 HTTP 回 409 说「尚未启动」(机制已定位,不必再派诊断)**
- 范围:`server/src/queue-seat.ts:282`、`server/src/task-start-receipt.ts:22`、`server/src/task-run.ts`(走到 `trackRun` :244 之前的收口路径)、`server/src/runs.ts` 的 `adoptRun`
- **机制**:那句 409 只在 `waitForStartReceipt` 解析为 `false` 时发出;而回执只有在 `adoptRun(handle)` → `acknowledgeStartReceipt` 于起跑作用域内跑过才算有 —— 也就是**只有真 agent handle 被消费循环接手**才算。原生命令(`/status` 这类)在 `task-run.ts` 走到 `trackRun` 之前就收口了,于是回合确实跑了、也确实按预期落了 `failed`,HTTP 那一侧却回 409。日志里没有 `[ash] 任务 … 启动异常`,证明 `start()` 没抛 —— 是**正常返回但没人发回执**,不是启动失败。
- **三处独立证据**:#156(全新任务、干净库,首次 `POST /run` 就 409;本轮单独复跑原样复现)、#491(命中同一行 409)、#371(「这一回合确实由本次调用接管了」false —— 正是因为没有回执这个事实)。#157 是同一条路的另一面:任务停在 `running` 没把占位还回来。
- **用户可感知后果**:在界面上给任务发一条带参数的 `/status`,看到的是「任务未通过启动检查，尚未启动，请稍后重试」,而真正的原因是「/status 不接受参数」。提示把人引向「重试」,而重试永远不会成功。
- 要拍的板是修哪一侧:① 原生命令这条路在收口前也发一次回执(倾向这条,因为它确实起跑了);② 或者把 409 的条件改成「只有真的没起跑才算」。

**T2b `test-review-wait-storage` 的字段形状(#284,与 T2 无关)**
- 等待所有权落库后读回 `pending` 得 `undefined`(期望 `false`)。它不走启动回执那条路,疑似 `6bde853c`(10-24)那轮 review 所有权改造留下的字段形状缺口,与 #281(已有主 `Wv2NXsDKnFgC`)同族 —— 先确认是不是同一个主在修。

### P2 — 测试契约过时(红绿信号失真)

**T6 web 回归四条:fixture 路由与选择器跟上前端**
- #38 `test-remote-return.mjs`(缺 `/api/tasks/:id/notices`、`/api/events` 路由桩)、#43 `test-monitor-wake.tsx`(正则对元素属性敏感)、#85 `test-assistant-entry.mjs`(等不到 `.workspace-assistant-entry`)、#122 `test-branch-acceptance.mjs`(`getByRole('alert')` strict mode 命中 2 个元素——页面新增了第二条 alert)
- 四条**全在门禁第 ② 步内**。门禁第 ① 步一通,它们就是下一道墙,建议和 T1 同批修。

**T7 验收前置命令那一笔的三条契约:错误文案与字段跟上**
- #257 `test-branch-worktree-state.ts`(期望 `/git worktree repair/`,实得「目标分支 … 已在另一个 worktree … 检出；未运行验收前置命令」)、#258 `test-base-update-recovery.ts`、#261 `test-branch-plan-creation.ts`(读回 `null`,期望 `'feature-x'`)
- 同一笔 `6bb6bdab`(10-23)引入,一张单改完。

**T8 handoff 三条:台子跟上方向身份与能力探测口径**
- #324 `test-handoff-auth.ts` 被 409「审查所属的原目标方向已失效，旧收尾不再修改目标」拦下——该闸是 `f19395a6`(10-24)审查所有权绑定新加的,台子(末笔 09-10)没带方向身份;#320 `test-handoff-capability.ts`「codex 标了 probe,清单却和内置快照一模一样」(断言用 `notDeepStrictEqual`,两者趋同即红);#322 `test-handoff.ts`「只有 findRollout 定位得到的 codex 会话算迁移成功」2≠1
- #322 需要先判是产品多认了一条会话还是台子多造了一条,不能直接当契约过时改掉。

**T10 `--settings` 注入口径:要么改断言、要么把钩子注入与「覆盖项」分开表达**
- `5bca1ec3`(10-16)让 `claude.ts` 无条件注入 Monitor 钩子的 `--settings`,而 `test-cli-overrides.ts:298` 钉的是「没配覆盖项、也没开加速档时不该多出一截参数」。
- 两种修法性质不同,要选:① 承认「钩子注入也算参数」→ 改断言;② 认为 `resumeFields` 不该把系统钩子算进「用户覆盖项」→ 改产品的字段语义。倾向 ②,因为页面上那条恢复命令是给人看的。

**T11 源码文本扫描型测试 vs 700 行拆分规则(系统性,建议单独立项)**
- **两条独立实例,同一笔责任提交 `9efd0081`(10-31)**:
  · #399 `test-session-lost.ts` 按文件名扫 `orchestrator.ts` 找 `affectedCodexResumeVersion`,它被拆进了 `turn-session-pick.ts`;
  · #508 `test-ash-mcp-reach.ts` 用正则 `/if \(!existsSync\(cwd\)\)[\s\S]{0,400}?taskWorkspace\(/` 扫同一个文件,那段逻辑被拆进了 `turn-workspace-pick.ts` —— 日志里 actual 甚至原样打出了新文件的注释「目录没了怎么办、还在又要刷什么,都在 turn-workspace-pick.ts」。
  两条**行为都一个字没丢**,测试照样红。一笔合规拆分一次打掉两条,说明这不是个例。
- 这不是一条红的事:项目有「单文件不超过 700 行、写到上限就拆」的硬规则,而仓库里有一批测试把「哪个文件里有哪段文字」当契约。每次合规拆分都会制造这种假红,而且失败信息长得像真缺陷(「没在起跑前识别受影响的 Codex 会话」)。
- 建议的根治方向(需用户拍板选一条):① 这类测试改成**顺着 import 图**扫该职责链的全部文件,而不是写死文件名;② 把「谁负责这一段」从文件名改为**显式注册表/导出标记**(编译期可查),测试扫注册表;③ 维持现状但在拆分规则旁边加一句「拆完要跟着改这几条扫描型测试」——最弱,仍然靠人记。

### P3 — 台子/环境

**T9 竞速型台子前提:`test-monitor-end-condition.ts` 改成确定性构造**
- 它的断言原文就是「四轮都没能让那一行赶在收尾之前送出去 —— 台子前提不成立,不是产品问题」:台子靠反复竞速去凑一个「哨兵输出赶在收尾之前」的前提,并发或机器一忙就凑不出来。
- 建议改成显式注入时序(或把该前提做成可强制的 fixture 开关),而不是重试四轮赌运气。

**T12 并发安全性标注:扫宿主进程表的测试要标「不可并行」**
- 实证:4 并发下 #475 `test-project-commands` 的孤儿进程扫描捞到了**本次审计自己的** pid 43703/43276,notice 写着「跟这次启动同属主、出生在这次启动之后,而环境里没有这次的记号」;于是断言期望的 `{stopped:true}` 多出了 `notice`/`unresolved` 两项。
- 同族嫌疑:#480 `test-service-ports`、#482 `test-terminal-capacity`(17≠16)、#484 `test-launch-abandon`、#406 `test-holder-scan`、#481 `test-service-ports-script`、#485 `test-launch-abandon-races`。
- 现状风险:`accept-test.mjs` 现在是**串行**跑两步,所以门禁本身不踩这个坑;但任何人想并行加速、或在同一台机器上同时跑两份验收,都会得到无法复现的红。建议在脚本头部或 package.json 里标出「独占进程表」,并让编排器尊重它。

### 本轮追加的四张单

**T13 — P1,高危:`test-service-ports-script` 会 SIGKILL 掉调用者的整个进程组**
- 范围:`server/scripts/test-service-ports-script.ts:75-76`、`server/scripts/test-service-ports-fixtures.ts:85`(`pidIn`)
- 实证:本轮两次复现。无 shield 时它把整个审计 runner 树一起带走(无退出码);加了进程组 shield 之后它只炸自己那一组,记录为 `sig=SIGKILL`、**日志 0 字节**。
- 机制:`pidIn = (f) => Number(readFileSync(f, "utf8").trim())`,pidfile 还没落盘时返回 `0`。`:75-76` 的 `const litePid = pidIn(litePidfile); strays.add(litePid)` **没有 `> 0` 守卫**,而紧邻的 `:77` 给 `liteWorkerPid` 加了 `waitFor(() => pidIn(liteWorker) > 0)` —— 这个不对称就是线索:`litePid` 前面那个 `waitFor` 只等「守护进程听上了端口」,不等它写完 pidfile。pid `0` 一旦进了任何组级信号,打的就是**调用方的整个进程组**。
- 产品侧已排除:`server/src/terminal-stop-script.ts:163` 的 `runStopScript` 用 `detached: !IS_WINDOWS`,用户停止脚本本来就跑在独立进程组里。责任在测试侧。
- 为什么要当 P1 修:按文档跑法 `npm run test:service-ports-script`,它会 SIGKILL 掉调用者的 shell 和 npm —— 开发者在终端里跑一次就掉一个窗口,而且没有任何输出说明原因。修法:`pidIn` 自己断言 `> 0`(读到空文件就重试或抛),并给 `litePid` 补上和 `liteWorkerPid` 同样的 `waitFor` 守卫。

**T14 — P2:`__name is not a function`(模块加载期就炸)**
- 范围:`server/src/team/lead-status.ts:46`,经 `team/session.ts:624` → `team/session-consumer.ts:91` 的加载链;表现为 #503 `test-team-turn-artifacts` 1 秒即红。
- 这不是业务断言失败,是 esbuild/tsx 的 `keepNames` 助手没注入到那个作用域的形态。先要判定:源码里某个语法踩了 tsx 的坑(那就改源码),还是工具链版本问题(那就钉版本)。注意**只有走 tsx 的那条路会炸**,`npm run build`(四个工作区)全绿,所以类型层和产物都没问题 —— 这正是它能长期潜伏的原因。

**T15 — P2:前端同步契约补 `acceptGateRunning`**
- 范围:`web/scripts/test-task-sync.mjs`(#535)与对应的同步类型。实际多出 `acceptGateRunning: true`,期望里没有 —— 前端同步契约没跟上验收前置命令新加的那个状态位。

**T16 — P2:web 包自有 UI 回归的可访问名/响应等待整体过时**
- #513 `test-cli-commands-ui.mjs`(等不到 `getByRole('textbox', { name: '回复任务' })`,30s)、#514 `test-cli-goal-lifecycle-ui.mjs`(`page.waitForResponse` 30s 超时)、#516 `test-chat-browser.mjs`(等不到 `getByRole('heading', { name: '创建一个聊天空间' })`,12s)、#560 `test-scm-race.mjs`(等不到 `getByRole('button', { name: '刷新 git 状态' })`,30s)
- 四条**都不在门禁 `test:web` 范围内**,所以门禁从来看不见它们。建议和 T17 一起处理,顺带决定这些要不要纳入门禁(见下面「门禁范围」那一节)。

**T17 — P2:git-workbench 三条布局断言跟上全局状态栏**
- #571 `test-git-workbench-review-fixes.mjs`(「历史 list must actually scroll」)、#574 `verify-git-workbench-refresh-paths.mjs`(「mobile staged selection button must fit viewport height」,按钮 bottom 1130 超出视口)、#576 `verify-git-workbench-design.mjs`(断言 workbench 恰好填满 `{0,0,1440,1000}`,实测 `height=974`)
- 责任笔 `abf768ff`(2026-09-17)「全局状态栏——常用命令启停/重启/日志,终端入口迁到底部栏」在底部占了 26px:1000 − 26 = **974**,数字对得上。viewport 是 `newPage({ viewport: { width: 1440, height: 1000 } })` **显式设定**的,所以排除浏览器通道因素(本轮用的是系统 Chrome + headless + 临时 profile)。
- 三条测试的末笔分别停在 2026-09-15 / 09-16 / 09-16,**比全局状态栏早一到两天**,之后再没动过 —— 也就是说它们**已经红了约六周**。

### 一条比单条红更要紧的结构性结论

把上面这些摊开看,「为什么从没有人见过完整的测试健康面貌」有两个互相叠加的机制:

1. **门禁第 ① 步一红就截断第 ② 步**。`scripts/accept-test.mjs` 在第一个失败步骤上 `process.exit(status)`,而第 ① 步(后端核心回归)里有 #267 这条稳定红 —— 于是第 ② 步「前端全量回归」**一条都不会跑**。门禁内的 web 四条(#38 #43 #85 #122)就是这么被遮住的。
2. **门禁范围之外有一整片无人看管的测试**。本轮 41 条非绿里有 34 条在门禁范围外,其中 #571/#574/#576 已经红了约六周(责任笔 09-17),而 web 包自有的 7 条 UI 回归、mobile 的 2 条、server 的一批 `test:*` 从来不在任何自动闸里。
   建议用户拍板一件事:**这些范围外脚本是该纳入门禁,还是该明确标注「手动/诊断用,不保证绿」**。两条路都行,但现状(既不跑也不标)等于让它们静默腐烂,而且每次有人偶然跑到一条,都要重新花时间判断「这是真缺陷还是陈年失修」—— 本次审计在这件事上花掉的时间就是代价本身。
## 六、范围外附加面(mcp / mobile)

这两个包的 `test:*` 不在用户声明的范围里(范围是 root/server/web),也不在验收门禁里,但它们确实存在、确实会被人跑到,所以一并真跑了一遍,单独成章。跑法同口径:各自独立临时 `ASH_DB`,`cwd` 取各包根目录。

| 包 | 脚本 | 结果 | 耗时 |
|---|---|---|---|
| mcp | `test:reconnect`(前置 `npm run build`) | 绿 | 8s |
| mcp | `test:read-transcript`(前置 `npm run build`) | 绿 | 1s |
| mobile | `test:project-path` | 绿 | 0s |
| mobile | `test:session-notices` | 绿 | 0s |
| mobile | `test:cli-capability` | 绿 | 0s |
| mobile | `test:markdown-inline` | 绿 | 1s |
| mobile | `test:monitor-strip` | 绿 | 9s |
| mobile | `test:task-branches` | 绿 | 9s |
| mobile | `test:web-smoke` | **红** | 0s |
| mobile | `test:reply-command-ui` | **红** | 41s |

合计 10 条,8 绿 2 红。两条红的归因:

**`mobile test:web-smoke` — 环境问题,不是缺陷。**
```
browserType.launch: Executable doesn't exist at
  ~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/...
```
playwright 浏览器版本错位:缓存里装的是别的版本号。关键是它**没有走仓库自己那套浏览器解析**(`web/scripts/chrome-path.mjs`:先找系统 Chrome/Chromium/Edge,都没有才回落到 playwright-core 自带),而是直接 launch 默认 chromium。`web` 侧那十几条 playwright 测试在同一台机器上全都起得来,就是因为走了那个解析器。建议修法是让 mobile 侧复用 `chrome-path.mjs`(或等价地显式传 `executablePath`),而**不是**去跑 `playwright install` —— 那会再装一份浏览器,且下次版本号一变又错位。

**`mobile test:reply-command-ui` — 契约过时。**
```
locator.click: Timeout 30000ms exceeded.
  waiting for getByRole('button', { name: '打开任务：手机命令 empty', exact: true })
```
`exact: true` 的可访问名 `打开任务：手机命令 empty` 对不上了。`empty` 这个词看起来是把某个状态标记拼进了按钮名,这类"状态 + 标题"拼出来的可访问名一旦渲染逻辑改动就会整条失配,而 `exact: true` 让它一点容错都没有。建议并入 T16(同一类:web/mobile 的 UI 回归按可访问名定位,名字随渲染改动漂移)。

---

<!-- 由 .audit/tables.mjs 生成 -->

总计 578:绿 540 / 红 38 / 超时 0 / 未跑 0
门禁内 187:绿 180 / 红 7 / 超时 0 / 未跑 0
门禁外 391:绿 360 / 红 31 / 超时 0 / 未跑 0

## 表 A:入口脚本(384 条)

| 入口 | 叶子数 | 门禁范围 | 结果 |
|---|---|---|---|
| `root:test:restart` | 8 | 门禁外 | 全绿 |
| `root:test:accept` | 1 | 门禁外 | 1 条未跑 |
| `root:test:accept-gate` | 1 | 门禁外 | 全绿 |
| `root:test:web` | 141 | 门禁内 | **4 条非绿** |
| `root:test:diagnostics` | 1 | 门禁外 | 全绿 |
| `server:test:cli-commands` | 11 | 门禁外 | **2 条非绿** |
| `server:test:diagnostic-session-reply` | 1 | 门禁外 | 全绿 |
| `server:test:goal-native-live` | 2 | 门禁外 | 全绿 |
| `server:test:side-chat` | 3 | 门禁内 | 全绿 |
| `server:test:assistant` | 1 | 门禁外 | 全绿 |
| `server:test:native-work` | 5 | 门禁内 | 全绿 |
| `server:test:chat-context` | 1 | 门禁外 | 全绿 |
| `server:test:chat` | 11 | 门禁外 | 全绿 |
| `server:test:task-memos` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-wake-data` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-delivery-batch` | 1 | 门禁外 | **1 条非绿** |
| `server:test:monitor-checkpoint-recovery` | 1 | 门禁内 | 全绿 |
| `server:test:preview-annotation` | 1 | 门禁外 | 全绿 |
| `server:test:preview-assist` | 1 | 门禁外 | 全绿 |
| `server:test:diagnostics` | 1 | 门禁外 | 全绿 |
| `server:test:singleton` | 1 | 门禁外 | 全绿 |
| `server:test:detached` | 3 | 门禁外 | 全绿 |
| `server:test:process-identity` | 1 | 门禁外 | 全绿 |
| `server:test:process-subtrees` | 1 | 门禁外 | 全绿 |
| `server:test:reattach` | 1 | 门禁外 | 全绿 |
| `server:test:monitors` | 39 | 门禁外 | **3 条非绿** |
| `server:test:queue` | 1 | 门禁外 | 全绿 |
| `server:test:search` | 1 | 门禁外 | 全绿 |
| `server:test:search-scan` | 1 | 门禁外 | 全绿 |
| `server:test:search-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:upload-names` | 1 | 门禁外 | 全绿 |
| `server:test:upload-visibility` | 2 | 门禁外 | 全绿 |
| `server:test:follow-up` | 1 | 门禁外 | 全绿 |
| `server:test:resume-prompt` | 1 | 门禁外 | 全绿 |
| `server:test:user-directives` | 1 | 门禁外 | 全绿 |
| `server:test:task-workspace` | 1 | 门禁外 | 全绿 |
| `server:test:file-delete` | 1 | 门禁外 | 全绿 |
| `server:test:open-in-ide` | 1 | 门禁外 | 全绿 |
| `server:test:turn-baseline` | 1 | 门禁外 | 全绿 |
| `server:test:turn-stall` | 1 | 门禁外 | 全绿 |
| `server:test:stall-flag` | 1 | 门禁外 | 全绿 |
| `server:test:stall-settle` | 1 | 门禁外 | 全绿 |
| `server:test:turn-stall-progress` | 1 | 门禁外 | 全绿 |
| `server:test:claude-retry-stall` | 1 | 门禁外 | 全绿 |
| `server:test:stall-restart` | 1 | 门禁外 | 全绿 |
| `server:test:turn-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:turn-reclaim` | 4 | 门禁外 | 全绿 |
| `server:test:turn-output` | 1 | 门禁外 | 全绿 |
| `server:test:reopen-acceptance` | 1 | 门禁外 | 全绿 |
| `server:test:branch-acceptance` | 5 | 门禁外 | **2 条非绿** |
| `server:test:branch-plan-creation` | 1 | 门禁外 | **1 条非绿** |
| `server:test:accept-merge` | 7 | 门禁内 | **1 条非绿** |
| `server:test:accept` | 46 | 门禁内 | **3 条非绿** |
| `server:test:accept-gate-process` | 2 | 门禁外 | 全绿 |
| `server:test:multi-user` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-setup` | 1 | 门禁外 | 全绿 |
| `server:test:onboarding-gate` | 1 | 门禁外 | 全绿 |
| `server:test:user-cli-smoke` | 1 | 门禁外 | 全绿 |
| `server:test:user-cli-mcp` | 3 | 门禁外 | 全绿 |
| `server:test:ash-mcp-registry` | 3 | 门禁外 | 全绿 |
| `server:test:personal-cli-settings` | 1 | 门禁内 | 全绿 |
| `server:test:handoff` | 18 | 门禁外 | **3 条非绿** |
| `server:test:handoff-capability` | 2 | 门禁外 | **1 条非绿** |
| `server:test:handoff-accepted-return` | 2 | 门禁外 | 全绿 |
| `server:test:handoff-remote-return` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-cli-config-dir` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-peer-key` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-outbound-key` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-key-persistence` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-key-concurrency` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-source-address` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-notice` | 1 | 门禁外 | 全绿 |
| `server:test:repo-lock` | 1 | 门禁外 | 全绿 |
| `server:test:project-git` | 1 | 门禁外 | 全绿 |
| `server:test:git-workbench` | 7 | 门禁外 | 全绿 |
| `server:test:project-clone` | 1 | 门禁外 | 全绿 |
| `server:test:project-dir` | 1 | 门禁外 | 全绿 |
| `server:test:project-git-config` | 1 | 门禁外 | 全绿 |
| `server:test:scm` | 1 | 门禁外 | 全绿 |
| `server:test:scm-guard` | 1 | 门禁外 | 全绿 |
| `server:test:scm-nested` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-recovery` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-default` | 1 | 门禁外 | 全绿 |
| `server:test:worktree-leftover` | 1 | 门禁外 | 全绿 |
| `server:test:archive-cleanup` | 2 | 门禁外 | 全绿 |
| `server:test:workspace-cleanup` | 1 | 门禁外 | 全绿 |
| `server:test:workspace-dirty` | 1 | 门禁外 | 全绿 |
| `server:test:executor-resolution` | 2 | 门禁外 | 全绿 |
| `server:test:ssh-retire` | 1 | 门禁外 | 全绿 |
| `server:test:answer-routing` | 1 | 门禁外 | 全绿 |
| `server:test:question-history` | 1 | 门禁外 | 全绿 |
| `server:test:team-native` | 1 | 门禁外 | 全绿 |
| `server:test:team-resilience` | 4 | 门禁外 | 全绿 |
| `server:test:team-inbound-durability` | 2 | 门禁外 | 全绿 |
| `server:test:native-turn` | 1 | 门禁外 | **1 条非绿** |
| `server:test:executor-overrides` | 1 | 门禁外 | 全绿 |
| `server:test:cli-overrides` | 1 | 门禁外 | **1 条非绿** |
| `server:test:claude-settings-live` | 1 | 门禁外 | 全绿 |
| `server:test:claude-relay-settings-live` | 1 | 门禁外 | 全绿 |
| `server:test:model-effort-isolation` | 1 | 门禁外 | 全绿 |
| `server:test:cli-catalog` | 1 | 门禁外 | 全绿 |
| `server:test:kimi` | 2 | 门禁外 | 全绿 |
| `server:test:kimi-live` | 1 | 门禁外 | 全绿 |
| `server:test:cli-models` | 1 | 门禁外 | 全绿 |
| `server:test:task-derivation` | 1 | 门禁外 | 全绿 |
| `server:test:task-creation-origin` | 1 | 门禁外 | 全绿 |
| `server:test:task-list-body` | 1 | 门禁外 | 全绿 |
| `server:test:task-event-timestamps` | 1 | 门禁外 | 全绿 |
| `server:test:notes` | 1 | 门禁外 | 全绿 |
| `server:test:star` | 1 | 门禁外 | 全绿 |
| `server:test:task-activity` | 1 | 门禁外 | 全绿 |
| `server:test:scheduled-messages` | 8 | 门禁外 | 全绿 |
| `server:test:review` | 27 | 门禁内 | **2 条非绿** |
| `server:test:regression-evidence` | 14 | 门禁内 | **2 条非绿** |
| `server:test:regression-reuse` | 1 | 门禁内 | 全绿 |
| `server:test:review-sweep` | 1 | 门禁内 | 全绿 |
| `server:test:prompt-budget` | 1 | 门禁内 | 全绿 |
| `server:test:browser-policy` | 1 | 门禁外 | 全绿 |
| `server:test:browser-grant-timing` | 1 | 门禁外 | **1 条非绿** |
| `server:test:claude-stream` | 1 | 门禁外 | 全绿 |
| `server:test:session-lost` | 1 | 门禁外 | **1 条非绿** |
| `server:test:duet-session-lost` | 1 | 门禁外 | 全绿 |
| `server:test:duet-stall-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:session-notice` | 2 | 门禁外 | 全绿 |
| `server:test:codex-resident` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-result` | 1 | 门禁外 | 全绿 |
| `server:test:holder-scan` | 1 | 门禁外 | **1 条非绿** |
| `server:test:cleanup-debt` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-pending` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:cleanup-write-handoff` | 1 | 门禁外 | 全绿 |
| `server:test:kernel-confine` | 1 | 门禁外 | 全绿 |
| `server:test:kill-lineage` | 1 | 门禁外 | 全绿 |
| `server:test:codex-archive` | 3 | 门禁外 | 全绿 |
| `server:test:codex-archive-live` | 1 | 门禁外 | 全绿 |
| `server:test:session-trace` | 1 | 门禁外 | 全绿 |
| `server:test:session-waiting` | 1 | 门禁外 | 全绿 |
| `server:test:session-read-errors` | 1 | 门禁外 | 全绿 |
| `server:test:conversation-turn` | 1 | 门禁外 | 全绿 |
| `server:test:retry-turn` | 1 | 门禁外 | 全绿 |
| `server:test:settlement-note` | 1 | 门禁外 | 全绿 |
| `server:test:turn-freeze` | 1 | 门禁外 | 全绿 |
| `server:test:turn-visibility` | 1 | 门禁外 | 全绿 |
| `server:test:agent-attachments` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-entry` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-journal` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-meta` | 1 | 门禁外 | 全绿 |
| `server:test:agent-image-stream` | 2 | 门禁外 | 全绿 |
| `server:test:usage` | 3 | 门禁外 | 全绿 |
| `server:test:peer-context` | 1 | 门禁外 | 全绿 |
| `server:test:auto-title` | 2 | 门禁外 | 全绿 |
| `server:test:workflow-mode-default` | 1 | 门禁外 | 全绿 |
| `server:test:workflow` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-library` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-run` | 1 | 门禁外 | 全绿 |
| `server:test:workflow-gate` | 1 | 门禁外 | 全绿 |
| `server:test:free-workflow` | 11 | 门禁内 | 全绿 |
| `server:test:review-resume` | 1 | 门禁内 | 全绿 |
| `server:test:free-workflow-preview` | 1 | 门禁内 | 全绿 |
| `server:test:agent-spawn-guard` | 1 | 门禁外 | 全绿 |
| `server:test:agent-cleanup` | 1 | 门禁外 | 全绿 |
| `server:test:verify-override` | 1 | 门禁外 | 全绿 |
| `server:test:foreign-bins` | 1 | 门禁外 | 全绿 |
| `server:test:preview-settings-proxy` | 1 | 门禁外 | 全绿 |
| `server:test:preview-command` | 2 | 门禁外 | 全绿 |
| `server:test:preview-log` | 1 | 门禁外 | 全绿 |
| `server:test:preview-lent-port` | 1 | 门禁外 | 全绿 |
| `server:test:preview-launch` | 1 | 门禁外 | 全绿 |
| `server:test:preview-host-api` | 1 | 门禁外 | 全绿 |
| `server:test:preview-cookies` | 1 | 门禁外 | 全绿 |
| `server:test:preview-process` | 1 | 门禁外 | 全绿 |
| `server:test:preview-stop-notice` | 1 | 门禁外 | 全绿 |
| `server:test:preview-seed` | 1 | 门禁外 | 全绿 |
| `server:test:preview-probe` | 1 | 门禁外 | 全绿 |
| `server:test:openai-converter` | 1 | 门禁外 | 全绿 |
| `server:test:anthropic-context-1m` | 1 | 门禁外 | 全绿 |
| `server:test:llm-relay` | 1 | 门禁外 | 全绿 |
| `server:test:skills` | 1 | 门禁外 | 全绿 |
| `server:test:file-browser` | 1 | 门禁外 | 全绿 |
| `server:test:task-file-raw` | 1 | 门禁外 | 全绿 |
| `server:test:task-artifacts` | 1 | 门禁外 | 全绿 |
| `server:test:artifact-scope` | 1 | 门禁外 | 全绿 |
| `server:test:task-page` | 1 | 门禁外 | 全绿 |
| `server:test:file-search` | 1 | 门禁外 | 全绿 |
| `server:test:local-open` | 1 | 门禁外 | 全绿 |
| `server:test:openers-windows` | 1 | 门禁外 | 全绿 |
| `server:test:dir-picker` | 1 | 门禁外 | 全绿 |
| `server:test:mcp-handoff` | 1 | 门禁外 | 全绿 |
| `server:test:duet-attachments` | 1 | 门禁外 | 全绿 |
| `server:test:terminal` | 13 | 门禁外 | **3 条非绿** |
| `server:test:win-launch` | 3 | 门禁外 | 全绿 |
| `server:test:path-boundary` | 1 | 门禁外 | 全绿 |
| `server:test:no-libsql` | 1 | 门禁外 | 全绿 |
| `server:test:handoff-free-workflow-rows` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-run` | 1 | 门禁外 | **1 条非绿** |
| `server:test:multi-user-git` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-agent` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-members` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-paths` | 1 | 门禁外 | 全绿 |
| `server:test:multi-user-settings` | 1 | 门禁外 | 全绿 |
| `server:test:missing-task-writes` | 1 | 门禁外 | 全绿 |
| `server:test:preview-deps` | 2 | 门禁外 | 全绿 |
| `server:test:page-annotation-batches` | 2 | 门禁外 | 全绿 |
| `server:test:annotation-batches` | 1 | 门禁外 | 全绿 |
| `server:test:preview-workspace` | 1 | 门禁外 | 全绿 |
| `server:test:monitor-races` | 1 | 门禁外 | **1 条非绿** |
| `server:test:db-tx` | 1 | 门禁外 | 全绿 |
| `server:test:turn-identity` | 3 | 门禁外 | **1 条非绿** |
| `server:test:turn-migration` | 1 | 门禁外 | 全绿 |
| `server:test:turn-persist` | 1 | 门禁外 | 全绿 |
| `server:test:duet-image-ownership` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-reach` | 1 | 门禁外 | **1 条非绿** |
| `server:test:ash-mcp-probe` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-file` | 1 | 门禁外 | 全绿 |
| `server:test:ash-mcp-launch` | 1 | 门禁外 | 全绿 |
| `server:test:stall-journal` | 1 | 门禁外 | 全绿 |
| `web:test:cli-commands` | 2 | 门禁外 | **2 条非绿** |
| `web:test:native-work` | 8 | 门禁内 | 全绿 |
| `web:test:native-agent-segments` | 1 | 门禁外 | 全绿 |
| `web:test:upstream-retry-placement` | 1 | 门禁内 | 全绿 |
| `web:test:chat` | 1 | 门禁外 | **1 条非绿** |
| `web:test` | 141 | 门禁内 | **4 条非绿** |
| `web:test:selection-content` | 1 | 门禁内 | 全绿 |
| `web:test:side-chat` | 9 | 门禁内 | 全绿 |
| `web:test:side-chat-upload` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-fork` | 3 | 门禁内 | 全绿 |
| `web:test:question-card` | 1 | 门禁内 | 全绿 |
| `web:test:question-history-dom` | 1 | 门禁内 | 全绿 |
| `web:test:page-token` | 1 | 门禁内 | 全绿 |
| `web:test:image-preview` | 1 | 门禁外 | 全绿 |
| `web:test:turn-images` | 1 | 门禁内 | 全绿 |
| `web:test:markdown-images` | 2 | 门禁内 | 全绿 |
| `web:test:inspector-shortcuts` | 1 | 门禁内 | 全绿 |
| `web:test:inspector-shortcut-stack` | 1 | 门禁内 | 全绿 |
| `web:test:key-chord` | 1 | 门禁内 | 全绿 |
| `web:test:roving-choice` | 1 | 门禁内 | 全绿 |
| `web:test:workspace-shortcuts` | 1 | 门禁内 | 全绿 |
| `web:test:sidebar-navigation` | 1 | 门禁内 | 全绿 |
| `web:test:sidebar-remote-race` | 1 | 门禁内 | 全绿 |
| `web:test:palette-keys` | 1 | 门禁内 | 全绿 |
| `web:test:palette-search` | 1 | 门禁内 | 全绿 |
| `web:test:shortcuts` | 8 | 门禁内 | 全绿 |
| `web:test:inspector-attachments` | 1 | 门禁外 | 全绿 |
| `web:test:open-with` | 1 | 门禁外 | 全绿 |
| `web:test:open-in-ide-menu` | 1 | 门禁外 | 全绿 |
| `web:test:cli-effort-policy` | 1 | 门禁内 | 全绿 |
| `web:test:run-target-picker` | 1 | 门禁外 | 全绿 |
| `web:test:provider-visibility` | 1 | 门禁内 | 全绿 |
| `web:test:executor-picker-field` | 1 | 门禁外 | 全绿 |
| `web:test:agent-profile-add-gate` | 1 | 门禁外 | 全绿 |
| `web:test:team-review-inspector` | 1 | 门禁外 | 全绿 |
| `web:test:free-review-copy` | 1 | 门禁外 | 全绿 |
| `web:test:reviewer-profile-summary` | 1 | 门禁外 | 全绿 |
| `web:test:free-workflow-inspector` | 1 | 门禁外 | 全绿 |
| `web:test:free-review-defer-dom` | 1 | 门禁内 | 全绿 |
| `web:test:free-review-delete` | 1 | 门禁内 | 全绿 |
| `web:test:dispute-timeline-cta` | 1 | 门禁内 | 全绿 |
| `web:test:debate-lane` | 1 | 门禁内 | 全绿 |
| `web:test:task-review-rounds` | 1 | 门禁外 | 全绿 |
| `web:test:review-report-sections` | 5 | 门禁内 | 全绿 |
| `web:test:review-report-split-dom` | 2 | 门禁内 | 全绿 |
| `web:test:review-diff-zoom` | 1 | 门禁外 | 全绿 |
| `web:test:data-layer` | 5 | 门禁外 | 全绿 |
| `web:test:session-merge` | 1 | 门禁外 | 全绿 |
| `web:test:task-sync` | 1 | 门禁外 | **1 条非绿** |
| `web:test:task-read-state` | 1 | 门禁内 | 全绿 |
| `web:test:scheduled-message-tray` | 3 | 门禁内 | 全绿 |
| `web:test:monitor-inspector` | 3 | 门禁内 | 全绿 |
| `web:test:task-memo-dom` | 1 | 门禁内 | 全绿 |
| `web:test:withdraw-scheduled` | 1 | 门禁内 | 全绿 |
| `web:test:users-role` | 1 | 门禁内 | 全绿 |
| `web:test:personal-cli-settings` | 2 | 门禁内 | 全绿 |
| `web:test:project-member-role` | 1 | 门禁内 | 全绿 |
| `web:test:create-project-scope` | 1 | 门禁内 | 全绿 |
| `web:test:ui-polish` | 1 | 门禁内 | 全绿 |
| `web:test:stick-to-bottom` | 2 | 门禁内 | 全绿 |
| `web:test:segment-layout` | 1 | 门禁内 | 全绿 |
| `web:test:confirm-enter` | 1 | 门禁内 | 全绿 |
| `web:test:send-key` | 1 | 门禁内 | 全绿 |
| `web:test:assistant-entry` | 1 | 门禁内 | **1 条非绿** |
| `web:test:select-all-on-focus` | 1 | 门禁内 | 全绿 |
| `web:test:run-activity` | 1 | 门禁外 | 全绿 |
| `web:test:tool-summary` | 1 | 门禁外 | 全绿 |
| `web:test:duet-timeline` | 1 | 门禁外 | 全绿 |
| `web:test:conversation-notes` | 1 | 门禁内 | 全绿 |
| `web:test:conversation` | 17 | 门禁内 | **1 条非绿** |
| `web:test:monitor-wake` | 2 | 门禁内 | **1 条非绿** |
| `web:test:conversation-task-switch` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-system-note` | 1 | 门禁内 | 全绿 |
| `web:test:settlement-note` | 1 | 门禁内 | 全绿 |
| `web:test:turn-fold` | 1 | 门禁内 | 全绿 |
| `web:test:claude-trace-accounting` | 1 | 门禁内 | 全绿 |
| `web:test:turn-fold-dom` | 1 | 门禁外 | 全绿 |
| `web:test:conversation-continuation` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-steer` | 1 | 门禁内 | 全绿 |
| `web:test:context-meter` | 1 | 门禁内 | 全绿 |
| `web:test:context-compact-quick` | 1 | 门禁内 | 全绿 |
| `web:test:client-id` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-notes-dom` | 1 | 门禁内 | 全绿 |
| `web:test:copy-feedback-dom` | 1 | 门禁内 | 全绿 |
| `web:test:system-notices-dom` | 1 | 门禁内 | 全绿 |
| `web:test:turn-remedy-dom` | 1 | 门禁内 | 全绿 |
| `web:test:turn-remedy-catch-up-dom` | 1 | 门禁内 | 全绿 |
| `web:test:task-catch-up-dom` | 1 | 门禁内 | 全绿 |
| `web:test:catch-up` | 1 | 门禁内 | 全绿 |
| `web:test:reviewer-turn` | 3 | 门禁内 | 全绿 |
| `web:test:reviewer-turn-dom` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree-preview` | 1 | 门禁外 | 全绿 |
| `web:test:task-tree-paging` | 2 | 门禁外 | 全绿 |
| `web:test:task-tree-offline` | 1 | 门禁外 | 全绿 |
| `web:test:bulk-handoff` | 1 | 门禁内 | 全绿 |
| `web:test:remote-task` | 2 | 门禁内 | **1 条非绿** |
| `web:test:handoff-dialog-lifetime` | 1 | 门禁内 | 全绿 |
| `web:test:handoff-source-addresses` | 1 | 门禁外 | 全绿 |
| `web:test:spread-filter` | 1 | 门禁外 | 全绿 |
| `web:test:outbound-state` | 1 | 门禁外 | 全绿 |
| `web:test:notes-filter` | 1 | 门禁外 | 全绿 |
| `web:test:slash-match` | 1 | 门禁外 | 全绿 |
| `web:test:file-mention` | 1 | 门禁外 | 全绿 |
| `web:test:file-tree-git` | 2 | 门禁内 | 全绿 |
| `web:test:diff-model` | 1 | 门禁内 | 全绿 |
| `web:test:file-diff-view` | 1 | 门禁内 | 全绿 |
| `web:test:file-view-zoom` | 1 | 门禁内 | 全绿 |
| `web:test:file-reel` | 1 | 门禁内 | 全绿 |
| `web:test:file-entry-delete` | 2 | 门禁内 | 全绿 |
| `web:test:file-mention-dom` | 1 | 门禁外 | 全绿 |
| `web:test:workspace-history` | 1 | 门禁外 | 全绿 |
| `web:test:reply-drafts` | 1 | 门禁外 | 全绿 |
| `web:test:composer-upload` | 1 | 门禁内 | 全绿 |
| `web:test:composer-draft` | 1 | 门禁内 | 全绿 |
| `web:test:composer-studio` | 1 | 门禁内 | 全绿 |
| `web:test:composer-branches` | 1 | 门禁内 | 全绿 |
| `web:test:composer-delete-race` | 1 | 门禁内 | 全绿 |
| `web:test:settle-created-task` | 1 | 门禁外 | 全绿 |
| `web:test:queue-after` | 1 | 门禁外 | 全绿 |
| `web:test:created-task-merge` | 1 | 门禁外 | 全绿 |
| `web:test:inspector-queue` | 1 | 门禁内 | 全绿 |
| `web:test:notes-upload` | 1 | 门禁内 | 全绿 |
| `web:test:notes-empty-body` | 1 | 门禁内 | 全绿 |
| `web:test:notes-delete-race` | 1 | 门禁内 | 全绿 |
| `web:test:duet-upload` | 1 | 门禁内 | 全绿 |
| `web:test:workflow-rail` | 1 | 门禁外 | 全绿 |
| `web:test:workflow-edit` | 1 | 门禁外 | 全绿 |
| `web:test:turn-retry` | 1 | 门禁外 | 全绿 |
| `web:test:scm-paths` | 1 | 门禁外 | 全绿 |
| `web:test:scm-stale` | 1 | 门禁外 | 全绿 |
| `web:test:scm-race` | 1 | 门禁外 | **1 条非绿** |
| `web:test:scm-nested-ui` | 1 | 门禁外 | 全绿 |
| `web:test:scm-file-layout` | 1 | 门禁外 | 全绿 |
| `web:test:file-layout-surfaces` | 1 | 门禁外 | 全绿 |
| `web:test:agent-plate` | 1 | 门禁外 | 全绿 |
| `web:test:reply-resize` | 1 | 门禁外 | 全绿 |
| `web:test:bulk-handoff-dialog` | 1 | 门禁内 | 全绿 |
| `web:test:auth-boot` | 1 | 门禁内 | 全绿 |
| `web:test:preview-url` | 1 | 门禁内 | 全绿 |
| `web:test:command-placeholders` | 1 | 门禁内 | 全绿 |
| `web:test:command-session-state` | 1 | 门禁内 | 全绿 |
| `web:test:terminal-dock` | 2 | 门禁内 | 全绿 |
| `web:test:project-settings-draft` | 1 | 门禁内 | 全绿 |
| `web:test:preview-assist-ui` | 1 | 门禁内 | 全绿 |
| `web:test:preview-log-live` | 1 | 门禁内 | 全绿 |
| `web:test:preview-task-switch` | 1 | 门禁内 | 全绿 |
| `web:test:preview-error-toast` | 1 | 门禁内 | 全绿 |
| `web:test:preview-port-guide` | 1 | 门禁内 | 全绿 |
| `web:test:settings-path-jump` | 1 | 门禁内 | 全绿 |
| `web:test:settings-card-fit` | 1 | 门禁内 | 全绿 |
| `web:test:reply-standing-executor` | 1 | 门禁内 | 全绿 |
| `web:test:branch-acceptance` | 3 | 门禁内 | **1 条非绿** |
| `web:test:accept-gate-dom` | 1 | 门禁内 | 全绿 |
| `web:test:reply-rail-dom` | 1 | 门禁内 | 全绿 |
| `web:test:task-creation-origin` | 1 | 门禁内 | 全绿 |
| `web:test:project-git-lifetime` | 1 | 门禁内 | 全绿 |
| `web:test:git-workbench` | 10 | 门禁外 | **2 条非绿** |
| `web:test:git-workbench-polling` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-design` | 1 | 门禁外 | **1 条非绿** |
| `web:test:git-workbench-header-resize` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-discard-menu` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-diff-prefixes` | 1 | 门禁外 | 全绿 |
| `web:test:git-workbench-refresh-paths` | 1 | 门禁外 | **1 条非绿** |
| `web:test:git-workbench-busy-discard` | 1 | 门禁外 | 全绿 |
| `web:test:annotation-review` | 2 | 门禁外 | 全绿 |
| `web:test:preview-workspace` | 1 | 门禁内 | 全绿 |
| `web:test:conversation-self-turn` | 1 | 门禁内 | 全绿 |

## 表 B:全量叶子(578 条)

| # | 包 | 叶子命令 | 门禁 | 结果 | 耗时 | 历次 |
|---|---|---|---|---|---|---|
| 10 | root | `test-accept-test.mjs` |  | 绿 | 3s | green |
| 3 | root | `test-process-identity.mjs` |  | 绿 | 0s | green |
| 4 | root | `test-process-ownership.mjs` |  | 绿 | 41s | green |
| 5 | root | `test-restart-options.mjs` |  | 绿 | 6s | green |
| 8 | root | `test-restart.mjs` |  | 绿 | 61s | green |
| 1 | root | `test-test-process-failures.mjs` |  | 绿 | 21s | green |
| 2 | root | `test-test-process.mjs` |  | 绿 | 21s | green |
| 7 | root | `test-windows-restart.mjs` |  | 绿 | 0s | green |
| 6 | root | `test-workspace-repair.mjs` |  | 绿 | 2s | green |
| 267 | server | `run-accept-gate-tests.mjs` | ✔ | **红** | 93s | red → red |
| 308 | server | `run-accept-gate-tests.mjs --command-only` |  | 绿 | 0s | green |
| 262 | server | `test-accept-auto-commit.ts` | ✔ | 绿 | 87s | green |
| 266 | server | `test-accept-cleanup.ts` | ✔ | 绿 | 321s | green |
| 264 | server | `test-accept-commit-setting.ts` | ✔ | 绿 | 15s | green |
| 307 | server | `test-accept-gate-process.ts` |  | 绿 | 35s | green |
| 263 | server | `test-accept-merge.ts` | ✔ | 绿 | 20s | green |
| 265 | server | `test-accept-pending-merge.ts` | ✔ | 绿 | 10s | green |
| 425 | server | `test-agent-attachments.ts` |  | 绿 | 0s | green |
| 443 | server | `test-agent-descendant-cleanup.ts` |  | 绿 | 2s | green |
| 426 | server | `test-agent-image-entry.ts` |  | 绿 | 4s | green |
| 427 | server | `test-agent-image-journal.ts` |  | 绿 | 0s | green |
| 428 | server | `test-agent-image-meta.ts` |  | 绿 | 0s | green |
| 430 | server | `test-agent-image-stream-window.ts` |  | 绿 | 1s | green |
| 429 | server | `test-agent-image-stream.ts` |  | 绿 | 3s | green |
| 442 | server | `test-agent-spawn-guard.ts` |  | 绿 | 0s | green |
| 362 | server | `test-answer-routing.ts` |  | 绿 | 1s | green |
| 459 | server | `test-anthropic-context-1m.ts` |  | 绿 | 1s | green |
| 355 | server | `test-archive-cleanup.ts` |  | 绿 | 13s | green |
| 356 | server | `test-archive-preview-guard.ts` |  | 绿 | 2s | green |
| 510 | server | `test-ash-mcp-file.ts` |  | 绿 | 1s | green |
| 317 | server | `test-ash-mcp-installer.ts` |  | 绿 | 1s | green |
| 511 | server | `test-ash-mcp-launch.ts` |  | 绿 | 1s | green |
| 509 | server | `test-ash-mcp-probe.ts` |  | 绿 | 26s | green |
| 508 | server | `test-ash-mcp-reach.ts` |  | **红** | 1s | red → red |
| 316 | server | `test-ash-mcp-registry.ts` |  | 绿 | 1s | green |
| 166 | server | `test-assistant.ts` |  | 绿 | 2s | green |
| 436 | server | `test-auto-title-run.ts` |  | 绿 | 1s | green |
| 435 | server | `test-auto-title.ts` |  | 绿 | 0s | green |
| 259 | server | `test-base-update-followups.ts` |  | 绿 | 116s | green |
| 258 | server | `test-base-update-recovery.ts` |  | **红** | 35s | red → red |
| 256 | server | `test-branch-acceptance.ts` |  | 绿 | 163s | green |
| 261 | server | `test-branch-plan-creation.ts` |  | **红** | 2s | red → red |
| 260 | server | `test-branch-plan-scale.ts` |  | 绿 | 19s | green |
| 257 | server | `test-branch-worktree-state.ts` |  | **红** | 2s | red → red |
| 397 | server | `test-browser-grant-timing.ts` |  | **红** | 1s | red → red |
| 396 | server | `test-browser-policy-grant.ts` |  | 绿 | 1s | green |
| 177 | server | `test-chat-ash-data.ts` |  | 绿 | 5s | green |
| 172 | server | `test-chat-boundary.ts` |  | 绿 | 14s | green |
| 167 | server | `test-chat-context.ts` |  | 绿 | 2s | green |
| 170 | server | `test-chat-deletion.ts` |  | 绿 | 2s | green |
| 171 | server | `test-chat-execution.ts` |  | 绿 | 11s | green |
| 176 | server | `test-chat-git-metadata.ts` |  | 绿 | 7s | green |
| 175 | server | `test-chat-large-workspace.ts` |  | 绿 | 16s | green |
| 173 | server | `test-chat-recovery.ts` |  | 绿 | 3s | green |
| 168 | server | `test-chat-review.ts` |  | 绿 | 2s | green |
| 174 | server | `test-chat-watch-load.ts` |  | 绿 | 7s | green |
| 169 | server | `test-chat.ts` |  | 绿 | 2s | green |
| 165 | server | `test-claude-goal-live.ts` |  | 绿 | 4s | green |
| 219 | server | `test-claude-monitor-backfill.ts` |  | 绿 | 1s | green |
| 229 | server | `test-claude-monitor-checkpoint.ts` |  | 绿 | 4s | green |
| 227 | server | `test-claude-monitor-completeness.ts` |  | 绿 | 9s | green |
| 228 | server | `test-claude-monitor-converge.ts` |  | 绿 | 4s | green |
| 216 | server | `test-claude-monitor-hook.ts` |  | 绿 | 4s | green |
| 224 | server | `test-claude-monitor-identity.ts` |  | 绿 | 1s | green |
| 220 | server | `test-claude-monitor-ledger.ts` |  | 绿 | 4s | green |
| 225 | server | `test-claude-monitor-origin.ts` |  | 绿 | 1s | green |
| 217 | server | `test-claude-monitor-parse.ts` |  | 绿 | 2s | green |
| 221 | server | `test-claude-monitor-pending-key.ts` |  | 绿 | 1s | green |
| 204 | server | `test-claude-monitor-projection.ts` |  | 绿 | 3s | green |
| 205 | server | `test-claude-monitor-reaped.ts` |  | 绿 | 2s | green |
| 223 | server | `test-claude-monitor-recovery.ts` |  | 绿 | 6s | green |
| 222 | server | `test-claude-monitor-unready.ts` |  | 绿 | 1s | green |
| 226 | server | `test-claude-monitor-upgrade.ts` |  | 绿 | 1s | green |
| 218 | server | `test-claude-monitor-wiring.ts` |  | 绿 | 2s | green |
| 375 | server | `test-claude-relay-settings-live.ts` |  | 绿 | 4s | green |
| 247 | server | `test-claude-retry-stall.ts` |  | 绿 | 1s | green |
| 374 | server | `test-claude-settings-live.ts` |  | 绿 | 3s | green |
| 394 | server | `test-claude-steer-ack.ts` |  | 绿 | 6s | green |
| 398 | server | `test-claude-stream-errors.ts` |  | 绿 | 11s | green |
| 432 | server | `test-claude-usage-accounting.ts` |  | 绿 | 1s | green |
| 433 | server | `test-claude-usage-migration.ts` |  | 绿 | 17s | green |
| 407 | server | `test-cleanup-debt.ts` |  | 绿 | 12s | green |
| 409 | server | `test-cleanup-ownership.ts` |  | 绿 | 6s | green |
| 408 | server | `test-cleanup-pending.ts` |  | 绿 | 1s | green |
| 405 | server | `test-cleanup-result.ts` |  | 绿 | 0s | green |
| 410 | server | `test-cleanup-write-handoff.ts` |  | 绿 | 13s | green |
| 163 | server | `test-cli-active-goal.ts` |  | 绿 | 1s | green |
| 377 | server | `test-cli-catalog.ts` |  | 绿 | 4s | green |
| 156 | server | `test-cli-command-startup.ts` |  | **红** | 1s | red → red |
| 155 | server | `test-cli-command-task.ts` |  | 绿 | 1s | green |
| 153 | server | `test-cli-commands.ts` |  | 绿 | 0s | green |
| 162 | server | `test-cli-goal-lifecycle.ts` |  | 绿 | 10s | green |
| 160 | server | `test-cli-goal-queue.ts` |  | 绿 | 27s | green |
| 159 | server | `test-cli-goal-recovery.ts` |  | 绿 | 8s | green |
| 380 | server | `test-cli-models.ts` |  | 绿 | 8s | green |
| 373 | server | `test-cli-overrides.ts` |  | **红** | 1s | red → red |
| 157 | server | `test-cli-plan-scheduling.ts` |  | **红** | 2s | red → red |
| 158 | server | `test-cli-state-scopes.ts` |  | 绿 | 1s | green |
| 416 | server | `test-codex-archive-live.ts` |  | 绿 | 27s | green |
| 415 | server | `test-codex-desktop-catalog.ts` |  | 绿 | 0s | green |
| 152 | server | `test-codex-diagnostics.ts` |  | 绿 | 1s | green |
| 154 | server | `test-codex-goal-bridge.ts` |  | 绿 | 1s | green |
| 315 | server | `test-codex-mcp-setup.mjs` |  | 绿 | 0s | green |
| 392 | server | `test-codex-mcp-turn-token.ts` |  | 绿 | 3s | green |
| 404 | server | `test-codex-resident.ts` |  | 绿 | 12s | green |
| 414 | server | `test-codex-resume-command.ts` |  | 绿 | 2s | green |
| 413 | server | `test-codex-session-archive.ts` |  | 绿 | 35s | green |
| 186 | server | `test-controllable-detached.ts` |  | 绿 | 1s | green |
| 420 | server | `test-conversation-turn.ts` |  | 绿 | 0s | green |
| 191 | server | `test-db-tx-ownership.ts` |  | 绿 | 0s | green |
| 185 | server | `test-detached-survival.ts` |  | 绿 | 4s | green |
| 161 | server | `test-diagnostic-session-reply.ts` |  | 绿 | 19s | green |
| 470 | server | `test-dir-picker.ts` |  | 绿 | 0s | green |
| 472 | server | `test-duet-attachments.ts` |  | 绿 | 1s | green |
| 507 | server | `test-duet-image-ownership.ts` |  | 绿 | 2s | green |
| 31 | server | `test-duet-native-trace.ts` | ✔ | 绿 | 2s | green |
| 400 | server | `test-duet-session-lost.ts` |  | 绿 | 1s | green |
| 401 | server | `test-duet-stall-visibility.ts` |  | 绿 | 1s | green |
| 360 | server | `test-executor-default-scope.ts` |  | 绿 | 1s | green |
| 372 | server | `test-executor-overrides.ts` |  | 绿 | 0s | green |
| 359 | server | `test-executor-resolution.ts` |  | 绿 | 2s | green |
| 462 | server | `test-file-browser.ts` |  | 绿 | 0s | green |
| 240 | server | `test-file-delete.ts` |  | 绿 | 3s | green |
| 467 | server | `test-file-search.ts` |  | 绿 | 0s | green |
| 236 | server | `test-follow-up.ts` |  | 绿 | 0s | green |
| 445 | server | `test-foreign-bins.ts` |  | 绿 | 0s | green |
| 303 | server | `test-free-preview-review-turn.ts` | ✔ | 绿 | 2s | green |
| 306 | server | `test-free-review-defer.ts` | ✔ | 绿 | 1s | green |
| 305 | server | `test-free-review-dispute.ts` | ✔ | 绿 | 1s | green |
| 298 | server | `test-free-review-reservation.ts` | ✔ | 绿 | 2s | green |
| 299 | server | `test-free-review-settlement.ts` | ✔ | 绿 | 6s | green |
| 301 | server | `test-free-workflow-hardening.ts` | ✔ | 绿 | 8s | green |
| 302 | server | `test-free-workflow-lifecycle.ts` | ✔ | 绿 | 5s | green |
| 297 | server | `test-free-workflow-preview.ts` | ✔ | 绿 | 4s | green |
| 296 | server | `test-free-workflow.ts` | ✔ | 绿 | 5s | green |
| 344 | server | `test-git-workbench-change-stats.ts` |  | 绿 | 1s | green |
| 342 | server | `test-git-workbench-maintenance.ts` |  | 绿 | 34s | green |
| 343 | server | `test-git-workbench-outcomes.ts` |  | 绿 | 75s | green |
| 345 | server | `test-git-workbench-partial-discard.ts` |  | 绿 | 19s | green |
| 341 | server | `test-git-workbench-safety.ts` |  | 绿 | 27s | green |
| 340 | server | `test-git-workbench.ts` |  | 绿 | 61s | green |
| 164 | server | `test-goal-native-live.ts` |  | 绿 | 97s | green |
| 332 | server | `test-handoff-accept-gate.ts` |  | 绿 | 1s | green |
| 331 | server | `test-handoff-accepted-return.ts` |  | 绿 | 4s | green |
| 324 | server | `test-handoff-auth.ts` |  | **红** | 7s | red → red |
| 321 | server | `test-handoff-capability-e2e.ts` |  | 绿 | 7s | green |
| 320 | server | `test-handoff-capability.ts` |  | **红** | 4s | red → red |
| 336 | server | `test-handoff-cli-config-dir.ts` |  | 绿 | 1s | green |
| 335 | server | `test-handoff-free-workflow-rows.ts` |  | 绿 | 0s | green |
| 334 | server | `test-handoff-holder.ts` |  | 绿 | 0s | green |
| 328 | server | `test-handoff-key-concurrency.ts` |  | 绿 | 1s | green |
| 327 | server | `test-handoff-key-persistence.ts` |  | 绿 | 1s | green |
| 323 | server | `test-handoff-local.ts` |  | 绿 | 1s | green |
| 333 | server | `test-handoff-notice.ts` |  | 绿 | 4s | green |
| 326 | server | `test-handoff-outbound-key.ts` |  | 绿 | 1s | green |
| 325 | server | `test-handoff-peer-key.ts` |  | 绿 | 1s | green |
| 319 | server | `test-handoff-remote-return.ts` |  | 绿 | 1s | green |
| 330 | server | `test-handoff-return.ts` |  | 绿 | 25s | green |
| 329 | server | `test-handoff-source-address.ts` |  | 绿 | 1s | green |
| 322 | server | `test-handoff.ts` |  | **红** | 6s | red → red |
| 406 | server | `test-holder-scan.ts` |  | **红** | 14s | red → red |
| 411 | server | `test-kernel-confine.ts` |  | 绿 | 0s | green |
| 412 | server | `test-kill-lineage.ts` |  | 绿 | 3s | green |
| 379 | server | `test-kimi-live.ts` |  | 绿 | 8s | green |
| 318 | server | `test-kimi-mcp.mjs` |  | 绿 | 0s | green |
| 378 | server | `test-kimi.ts` |  | 绿 | 2s | green |
| 485 | server | `test-launch-abandon-races.ts` |  | 绿 | 14s | green |
| 484 | server | `test-launch-abandon.ts` |  | 绿 | 3s | red → green |
| 460 | server | `test-llm-relay.ts` |  | 绿 | 3s | green |
| 468 | server | `test-local-open.ts` |  | 绿 | 0s | green |
| 471 | server | `test-mcp-handoff.ts` |  | 绿 | 1s | green |
| 497 | server | `test-missing-task-writes.ts` |  | 绿 | 1s | green |
| 376 | server | `test-model-effort-isolation.ts` |  | 绿 | 4s | green |
| 197 | server | `test-monitor-block-eligibility.ts` |  | 绿 | 29s | green |
| 181 | server | `test-monitor-checkpoint-recovery.ts` | ✔ | 绿 | 152s | green |
| 209 | server | `test-monitor-complete-columns.ts` |  | 绿 | 1s | green |
| 208 | server | `test-monitor-complete-gate.ts` |  | **红** | 4s | red → red |
| 199 | server | `test-monitor-create-protocol.ts` |  | 绿 | 5s | green |
| 202 | server | `test-monitor-create-window.ts` |  | 绿 | 14s | green |
| 180 | server | `test-monitor-delivery-batch.ts` |  | **红** | 53s | red → red |
| 196 | server | `test-monitor-end-condition-gate.ts` |  | 绿 | 2s | green |
| 195 | server | `test-monitor-end-condition.ts` |  | 绿 | 8s | red → green |
| 215 | server | `test-monitor-generation.ts` |  | 绿 | 5s | green |
| 200 | server | `test-monitor-intent-handover.ts` |  | 绿 | 19s | green |
| 193 | server | `test-monitor-offline.ts` |  | 绿 | 18s | green |
| 194 | server | `test-monitor-owed-batch.ts` |  | 绿 | 11s | green |
| 198 | server | `test-monitor-perturbation.ts` |  | 绿 | 0s | green |
| 203 | server | `test-monitor-races.ts` |  | **红** | 8s | red → red |
| 211 | server | `test-monitor-reclaim-debt.ts` |  | 绿 | 43s | green |
| 212 | server | `test-monitor-reclaim-identity.ts` |  | 绿 | 11s | green |
| 213 | server | `test-monitor-reclaim-unit.ts` |  | 绿 | 32s | green |
| 210 | server | `test-monitor-result-lifecycle.ts` |  | 绿 | 3s | green |
| 207 | server | `test-monitor-review-lifecycle.ts` |  | **红** | 2s | red → red |
| 201 | server | `test-monitor-settle-handover.ts` |  | 绿 | 33s | green |
| 214 | server | `test-monitor-unit-proof.ts` |  | 绿 | 40s | green |
| 179 | server | `test-monitor-wake-data.ts` |  | 绿 | 2s | green |
| 206 | server | `test-monitor-wake-role.ts` |  | 绿 | 4s | green |
| 192 | server | `test-monitors.ts` |  | 绿 | 16s | green |
| 493 | server | `test-multi-user-agent.ts` |  | 绿 | 1s | green |
| 492 | server | `test-multi-user-git.ts` |  | 绿 | 5s | green |
| 494 | server | `test-multi-user-members.ts` |  | 绿 | 1s | green |
| 495 | server | `test-multi-user-paths.ts` |  | 绿 | 0s | green |
| 491 | server | `test-multi-user-run.ts` |  | **红** | 3s | red → red |
| 496 | server | `test-multi-user-settings.ts` |  | 绿 | 0s | green |
| 310 | server | `test-multi-user-setup.ts` |  | 绿 | 2s | green |
| 309 | server | `test-multi-user.ts` |  | 绿 | 2s | green |
| 29 | server | `test-native-activity-stream.ts` | ✔ | 绿 | 1s | green |
| 28 | server | `test-native-agent-models.ts` | ✔ | 绿 | 1s | green |
| 371 | server | `test-native-command-turn.ts` |  | **红** | 1s | red → red |
| 393 | server | `test-native-steer.ts` |  | 绿 | 3s | green |
| 30 | server | `test-native-upload-visibility.ts` | ✔ | 绿 | 3s | green |
| 27 | server | `test-native-work.ts` | ✔ | 绿 | 2s | green |
| 490 | server | `test-no-libsql.ts` |  | 绿 | 1s | green |
| 385 | server | `test-note-task-history.ts` |  | 绿 | 1s | green |
| 311 | server | `test-onboarding-gate.ts` |  | 绿 | 1s | green |
| 241 | server | `test-open-in-ide.ts` |  | 绿 | 4s | green |
| 458 | server | `test-openai-converter.ts` |  | 绿 | 1s | green |
| 469 | server | `test-openers-windows.ts` |  | 绿 | 0s | green |
| 500 | server | `test-page-annotation-batches.ts` |  | 绿 | 1s | green |
| 489 | server | `test-path-boundary.ts` |  | 绿 | 0s | green |
| 434 | server | `test-peer-context.ts` |  | 绿 | 0s | green |
| 75 | server | `test-personal-cli-settings.ts` | ✔ | 绿 | 0s | green |
| 304 | server | `test-post-merge-review.ts` | ✔ | 绿 | 2s | green |
| 487 | server | `test-powershell-command.ts` |  | 绿 | 0s | green |
| 182 | server | `test-preview-annotation.ts` |  | 绿 | 0s | green |
| 183 | server | `test-preview-assist.ts` |  | 绿 | 12s | green |
| 499 | server | `test-preview-cache-path.ts` |  | 绿 | 0s | green |
| 447 | server | `test-preview-command.ts` |  | 绿 | 0s | green |
| 453 | server | `test-preview-cookies.ts` |  | 绿 | 0s | green |
| 498 | server | `test-preview-deps.ts` |  | 绿 | 3s | green |
| 452 | server | `test-preview-host-api.ts` |  | 绿 | 3s | green |
| 451 | server | `test-preview-launch.ts` |  | 绿 | 4s | green |
| 450 | server | `test-preview-lent-port.ts` |  | 绿 | 2s | green |
| 449 | server | `test-preview-log.ts` |  | 绿 | 0s | green |
| 457 | server | `test-preview-probe.ts` |  | 绿 | 0s | green |
| 454 | server | `test-preview-process.ts` |  | 绿 | 21s | green |
| 456 | server | `test-preview-seed.ts` |  | 绿 | 0s | green |
| 446 | server | `test-preview-settings-proxy.ts` |  | 绿 | 13s | green |
| 448 | server | `test-preview-static.ts` |  | 绿 | 4s | green |
| 455 | server | `test-preview-stop-notice.ts` |  | 绿 | 2s | green |
| 501 | server | `test-preview-workspace.ts` |  | 绿 | 5s | green |
| 188 | server | `test-process-identity.ts` |  | 绿 | 33s | green |
| 189 | server | `test-process-subtrees.ts` |  | 绿 | 8s | green |
| 346 | server | `test-project-clone.ts` |  | 绿 | 2s | green |
| 475 | server | `test-project-commands.ts` |  | **红** | 6s | red → red |
| 347 | server | `test-project-dir.ts` |  | 绿 | 1s | green |
| 348 | server | `test-project-git-config.ts` |  | 绿 | 3s | green |
| 338 | server | `test-project-git.ts` |  | 绿 | 13s | green |
| 271 | server | `test-prompt-budget.ts` | ✔ | 绿 | 1s | green |
| 363 | server | `test-question-history.ts` |  | 绿 | 1s | green |
| 230 | server | `test-queue-order.ts` |  | 绿 | 1s | green |
| 190 | server | `test-reattach.ts` |  | 绿 | 12s | green |
| 277 | server | `test-regression-availability.ts` | ✔ | 绿 | 2s | green |
| 278 | server | `test-regression-conclusion-atomicity.ts` | ✔ | 绿 | 6s | green |
| 295 | server | `test-regression-file-types.ts` | ✔ | 绿 | 3s | green |
| 274 | server | `test-regression-input.ts` | ✔ | 绿 | 7s | green |
| 276 | server | `test-regression-lifecycle.ts` | ✔ | 绿 | 5s | green |
| 275 | server | `test-regression-order.ts` | ✔ | 绿 | 7s | green |
| 280 | server | `test-regression-recovery.ts` | ✔ | 绿 | 36s | green |
| 273 | server | `test-regression-reuse.ts` | ✔ | 绿 | 11s | green |
| 279 | server | `test-regression-settlement.ts` | ✔ | 绿 | 22s | green |
| 272 | server | `test-regression-start.ts` | ✔ | 绿 | 3s | green |
| 255 | server | `test-reopen-acceptance.ts` |  | 绿 | 0s | green |
| 288 | server | `test-repair-start.ts` | ✔ | 绿 | 11s | green |
| 337 | server | `test-repo-lock.ts` |  | 绿 | 7s | green |
| 237 | server | `test-resume-prompt-broadcast.ts` |  | 绿 | 1s | green |
| 421 | server | `test-retry-turn.ts` |  | 绿 | 1s | green |
| 292 | server | `test-review-accepted-policy.ts` | ✔ | 绿 | 12s | green |
| 290 | server | `test-review-accepted-tail.ts` | ✔ | 绿 | 12s | green |
| 286 | server | `test-review-boundaries.ts` | ✔ | 绿 | 21s | green |
| 289 | server | `test-review-delivery-freeze.ts` | ✔ | 绿 | 19s | green |
| 285 | server | `test-review-entry.ts` | ✔ | 绿 | 11s | green |
| 269 | server | `test-review-flow.ts` | ✔ | 绿 | 2s | green |
| 294 | server | `test-review-gate-repair.ts` | ✔ | 绿 | 3s | green |
| 282 | server | `test-review-history.ts` | ✔ | 绿 | 44s | green |
| 281 | server | `test-review-ownership.ts` | ✔ | **红** | 14s | red → red |
| 293 | server | `test-review-repair-delivery.ts` | ✔ | 绿 | 15s | green |
| 300 | server | `test-review-resume.ts` | ✔ | 绿 | 1s | green |
| 291 | server | `test-review-start-recovery.ts` | ✔ | 绿 | 90s | green |
| 270 | server | `test-review-sweep.ts` | ✔ | 绿 | 1s | green |
| 287 | server | `test-review-transfer.ts` | ✔ | 绿 | 3s | green |
| 284 | server | `test-review-wait-storage.ts` | ✔ | **红** | 11s | red → red |
| 283 | server | `test-review-wait.ts` | ✔ | 绿 | 29s | green |
| 395 | server | `test-run-notices.ts` |  | 绿 | 2s | green |
| 388 | server | `test-scheduled-messages.ts` |  | 绿 | 144s | green |
| 350 | server | `test-scm-guard.ts` |  | 绿 | 14s | green |
| 351 | server | `test-scm-nested.ts` |  | 绿 | 3s | green |
| 349 | server | `test-scm-workspace.ts` |  | 绿 | 8s | green |
| 231 | server | `test-search-query.ts` |  | 绿 | 0s | green |
| 232 | server | `test-search-scan.ts` |  | 绿 | 1s | green |
| 233 | server | `test-search-visibility.ts` |  | 绿 | 2s | green |
| 251 | server | `test-seat-ownership.ts` |  | 绿 | 1s | green |
| 476 | server | `test-service-ports-scan.ts` |  | 绿 | 0s | green |
| 481 | server | `test-service-ports-script.ts` |  | 绿 | 18s | red → green |
| 480 | server | `test-service-ports.ts` |  | **红** | 18s | red → red |
| 399 | server | `test-session-lost.ts` |  | **红** | 1s | red → red |
| 402 | server | `test-session-notice.ts` |  | 绿 | 1s | green |
| 419 | server | `test-session-read-errors.ts` |  | 绿 | 1s | green |
| 417 | server | `test-session-trace.ts` |  | 绿 | 0s | green |
| 502 | server | `test-session-turn-identity.ts` |  | 绿 | 87s | green |
| 505 | server | `test-session-turn-migration.ts` |  | 绿 | 0s | green |
| 506 | server | `test-session-turn-persist.ts` |  | 绿 | 1s | green |
| 418 | server | `test-session-waiting.ts` |  | 绿 | 0s | green |
| 422 | server | `test-settlement-note.ts` |  | 绿 | 1s | green |
| 11 | server | `test-side-authorization.ts` | ✔ | 绿 | 0s | green |
| 13 | server | `test-side-chat-deletion.ts` | ✔ | 绿 | 1s | green |
| 12 | server | `test-side-chat.ts` | ✔ | 绿 | 6s | green |
| 184 | server | `test-singleton.ts` |  | 绿 | 21s | green |
| 461 | server | `test-skills.ts` |  | 绿 | 1s | green |
| 361 | server | `test-ssh-profile-retire.ts` |  | 绿 | 1s | green |
| 244 | server | `test-stall-flag.ts` |  | 绿 | 1s | green |
| 512 | server | `test-stall-journal.ts` |  | 绿 | 4s | green |
| 248 | server | `test-stall-restart.ts` |  | 绿 | 24s | green |
| 245 | server | `test-stall-settle.ts` |  | 绿 | 1s | green |
| 477 | server | `test-stop-evidence.ts` |  | 绿 | 0s | green |
| 478 | server | `test-stop-review.ts` |  | 绿 | 4s | green |
| 252 | server | `test-stop-turn-observation.ts` |  | 绿 | 1s | green |
| 479 | server | `test-stop-verification.ts` |  | 绿 | 9s | green |
| 387 | server | `test-task-activity.ts` |  | 绿 | 1s | green |
| 465 | server | `test-task-artifact-scope.ts` |  | 绿 | 6s | green |
| 464 | server | `test-task-artifacts.ts` |  | 绿 | 3s | green |
| 268 | server | `test-task-background-state.ts` | ✔ | 绿 | 1s | green |
| 382 | server | `test-task-creation-origin.ts` |  | 绿 | 1s | green |
| 381 | server | `test-task-derivation-policy.ts` |  | 绿 | 1s | green |
| 391 | server | `test-task-direction-epoch-entries.ts` |  | 绿 | 8s | green |
| 384 | server | `test-task-event-timestamps.ts` |  | 绿 | 1s | green |
| 463 | server | `test-task-file-raw.ts` |  | 绿 | 1s | green |
| 383 | server | `test-task-list-body.ts` |  | 绿 | 1s | green |
| 178 | server | `test-task-memos.ts` |  | 绿 | 1s | green |
| 466 | server | `test-task-page.ts` |  | 绿 | 1s | green |
| 386 | server | `test-task-star.ts` |  | 绿 | 1s | green |
| 389 | server | `test-task-steer-hardening.ts` |  | 绿 | 1s | green |
| 390 | server | `test-task-steer-rollback.ts` |  | 绿 | 1s | green |
| 239 | server | `test-task-workspace.ts` |  | 绿 | 7s | green |
| 369 | server | `test-team-inbound-durability.ts` |  | 绿 | 3s | green |
| 370 | server | `test-team-inbound-interleave.ts` |  | 绿 | 1s | green |
| 366 | server | `test-team-inbound-resilience.ts` |  | 绿 | 3s | green |
| 365 | server | `test-team-lead-resilience.ts` |  | 绿 | 4s | green |
| 364 | server | `test-team-native-command.ts` |  | 绿 | 1s | green |
| 368 | server | `test-team-notice-trace.ts` |  | 绿 | 2s | green |
| 403 | server | `test-team-session-notice.ts` |  | 绿 | 3s | green |
| 503 | server | `test-team-turn-artifacts.ts` |  | **红** | 1s | red → red |
| 367 | server | `test-team-user-interrupt.ts` |  | 绿 | 1s | green |
| 482 | server | `test-terminal-capacity.ts` |  | **红** | 13s | red → red |
| 483 | server | `test-terminal-lifecycle.ts` |  | 绿 | 5s | green |
| 473 | server | `test-terminal-pty.ts` |  | 绿 | 6s | green |
| 474 | server | `test-terminal.ts` |  | 绿 | 15s | green |
| 242 | server | `test-turn-baseline.ts` |  | 绿 | 3s | green |
| 423 | server | `test-turn-freeze.ts` |  | 绿 | 1s | green |
| 504 | server | `test-turn-identity-bridge.ts` |  | 绿 | 0s | green |
| 254 | server | `test-turn-output.ts` |  | 绿 | 1s | green |
| 249 | server | `test-turn-ownership.ts` |  | 绿 | 1s | green |
| 250 | server | `test-turn-reclaim.ts` |  | 绿 | 5s | green |
| 253 | server | `test-turn-release-ownership.ts` |  | 绿 | 1s | green |
| 246 | server | `test-turn-stall-progress.ts` |  | 绿 | 0s | green |
| 243 | server | `test-turn-stall.ts` |  | 绿 | 11s | green |
| 424 | server | `test-turn-visibility.ts` |  | 绿 | 2s | green |
| 234 | server | `test-upload-names.ts` |  | 绿 | 1s | green |
| 235 | server | `test-upload-visibility.ts` |  | 绿 | 6s | green |
| 431 | server | `test-usage-accounting.ts` |  | 绿 | 1s | green |
| 313 | server | `test-user-cli-mcp.ts` |  | 绿 | 1s | green |
| 312 | server | `test-user-cli-smoke.ts` |  | 绿 | 0s | green |
| 314 | server | `test-user-cli-write-identity.ts` |  | 绿 | 0s | green |
| 238 | server | `test-user-directives.ts` |  | 绿 | 0s | green |
| 488 | server | `test-user-shell-powershell.ts` |  | 绿 | 0s | green |
| 444 | server | `test-verify-override.ts` |  | 绿 | 2s | green |
| 486 | server | `test-win-launch.ts` |  | 绿 | 0s | green |
| 187 | server | `test-windows-detached.ts` |  | 绿 | 1s | green |
| 438 | server | `test-workflow-def.ts` |  | 绿 | 0s | green |
| 441 | server | `test-workflow-gate.ts` |  | 绿 | 2s | green |
| 439 | server | `test-workflow-library.ts` |  | 绿 | 1s | green |
| 437 | server | `test-workflow-mode-default.ts` |  | 绿 | 1s | green |
| 440 | server | `test-workflow-run.ts` |  | 绿 | 11s | green |
| 357 | server | `test-workspace-cleanup.ts` |  | 绿 | 3s | green |
| 358 | server | `test-workspace-dirty.ts` |  | 绿 | 1s | green |
| 353 | server | `test-worktree-default.ts` |  | 绿 | 2s | green |
| 354 | server | `test-worktree-leftover.ts` |  | 绿 | 3s | green |
| 339 | server | `test-worktree-porcelain.ts` |  | 绿 | 3s | green |
| 352 | server | `test-worktree-recovery.ts` |  | 绿 | 3s | green |
| 133 | web | `../server/scripts/test-file-delete.ts` | ✔ | 绿 | 6s | green |
| 127 | web | `../server/scripts/test-file-git-status.ts` | ✔ | 绿 | 2s | green |
| 22 | web | `../server/scripts/test-task-reply-fork.ts` | ✔ | 绿 | 2s | green |
| 123 | web | `test-accept-gate-dom.mjs` | ✔ | 绿 | 202s | green |
| 121 | web | `test-acceptance-workspace-commit-dom.mjs` | ✔ | 绿 | 20s | green |
| 564 | web | `test-agent-plate.mjs` |  | 绿 | 12s | green |
| 523 | web | `test-agent-profile-add-gate.mjs` |  | 绿 | 11s | green |
| 579 | web | `test-annotation-review-presentation.tsx` |  | 绿 | 4s | green |
| 578 | web | `test-annotation-review.ts` |  | 绿 | 0s | green |
| 85 | web | `test-assistant-entry.mjs` | ✔ | **红** | 23s | red → red |
| 106 | web | `test-auth-boot.mjs` | ✔ | 绿 | 18s | green |
| 122 | web | `test-branch-acceptance.mjs` | ✔ | **红** | 78s | red → red |
| 36 | web | `test-bulk-handoff-dialog.mjs` | ✔ | 绿 | 15s | green |
| 35 | web | `test-bulk-handoff.mjs` | ✔ | 绿 | 0s | green |
| 64 | web | `test-catch-up.mjs` | ✔ | 绿 | 0s | green |
| 516 | web | `test-chat-browser.mjs` |  | **红** | 24s | red → red |
| 51 | web | `test-claude-trace-accounting.mjs` | ✔ | 绿 | 0s | green |
| 513 | web | `test-cli-commands-ui.mjs` |  | **红** | 40s | red → red |
| 149 | web | `test-cli-effort-policy.mjs` | ✔ | 绿 | 14s | green |
| 514 | web | `test-cli-goal-lifecycle-ui.mjs` |  | **红** | 40s | red → red |
| 40 | web | `test-client-id.mjs` | ✔ | 绿 | 0s | green |
| 111 | web | `test-command-placeholders.mjs` | ✔ | 绿 | 17s | green |
| 113 | web | `test-command-session-state.mjs` | ✔ | 绿 | 0s | green |
| 90 | web | `test-composer-branches.mjs` | ✔ | 绿 | 21s | green |
| 91 | web | `test-composer-delete-race.mjs` | ✔ | 绿 | 17s | green |
| 88 | web | `test-composer-draft.mjs` | ✔ | 绿 | 17s | green |
| 89 | web | `test-composer-studio.mjs` | ✔ | 绿 | 21s | green |
| 87 | web | `test-composer-upload.mjs` | ✔ | 绿 | 17s | green |
| 83 | web | `test-confirm-enter.mjs` | ✔ | 绿 | 14s | green |
| 53 | web | `test-context-compact-quick.mjs` | ✔ | 绿 | 13s | green |
| 52 | web | `test-context-meter.tsx` | ✔ | 绿 | 2s | green |
| 42 | web | `test-conversation-continuation.tsx` | ✔ | 绿 | 2s | green |
| 23 | web | `test-conversation-fork-dom.mjs` | ✔ | 绿 | 15s | green |
| 21 | web | `test-conversation-fork.ts` | ✔ | 绿 | 0s | green |
| 57 | web | `test-conversation-notes-dom.mjs` | ✔ | 绿 | 13s | green |
| 41 | web | `test-conversation-notes.mjs` | ✔ | 绿 | 0s | green |
| 46 | web | `test-conversation-self-turn.mjs` | ✔ | 绿 | 0s | green |
| 45 | web | `test-conversation-steer.mjs` | ✔ | 绿 | 0s | green |
| 47 | web | `test-conversation-system-note.mjs` | ✔ | 绿 | 0s | green |
| 48 | web | `test-conversation-task-switch.mjs` | ✔ | 绿 | 25s | green |
| 59 | web | `test-copy-feedback-dom.mjs` | ✔ | 绿 | 16s | green |
| 78 | web | `test-create-project-scope.mjs` | ✔ | 绿 | 15s | green |
| 532 | web | `test-created-task-merge.mjs` |  | 绿 | 0s | green |
| 530 | web | `test-data-layer.mjs` |  | 绿 | 0s | green |
| 148 | web | `test-debate-lane.mjs` | ✔ | 绿 | 13s | green |
| 129 | web | `test-diff-model.ts` | ✔ | 绿 | 0s | green |
| 147 | web | `test-dispute-timeline-cta.mjs` | ✔ | 绿 | 17s | green |
| 538 | web | `test-duet-timeline.mjs` |  | 绿 | 0s | green |
| 96 | web | `test-duet-upload.mjs` | ✔ | 绿 | 14s | green |
| 522 | web | `test-executor-picker-field.mjs` |  | 绿 | 11s | green |
| 130 | web | `test-file-diff-view.mjs` | ✔ | 绿 | 17s | green |
| 134 | web | `test-file-entry-delete.mjs` | ✔ | 绿 | 14s | green |
| 563 | web | `test-file-layout-surfaces.mjs` |  | 绿 | 15s | green |
| 552 | web | `test-file-mention-dom.mjs` |  | 绿 | 16s | green |
| 551 | web | `test-file-mention.mjs` |  | 绿 | 0s | green |
| 132 | web | `test-file-reel.mjs` | ✔ | 绿 | 15s | green |
| 128 | web | `test-file-tree-git.mjs` | ✔ | 绿 | 22s | green |
| 131 | web | `test-file-view-zoom.mjs` | ✔ | 绿 | 15s | green |
| 525 | web | `test-free-review-copy.mjs` |  | 绿 | 0s | green |
| 135 | web | `test-free-review-defer-dom.mjs` | ✔ | 绿 | 15s | green |
| 136 | web | `test-free-review-delete.mjs` | ✔ | 绿 | 41s | green |
| 527 | web | `test-free-workflow-inspector.mjs` |  | 绿 | 16s | green |
| 570 | web | `test-git-workbench-conflict-errors.mjs` |  | 绿 | 61s | green |
| 569 | web | `test-git-workbench-conflict-gates.mjs` |  | 绿 | 52s | green |
| 566 | web | `test-git-workbench-polling.mjs` |  | 绿 | 45s | green |
| 571 | web | `test-git-workbench-review-fixes.mjs` |  | **红** | 19s | red → red |
| 568 | web | `test-git-workbench-review.mjs` |  | 绿 | 50s | green |
| 567 | web | `test-git-workbench.mjs` |  | 绿 | 59s | green |
| 39 | web | `test-handoff-dialog-lifetime.mjs` | ✔ | 绿 | 0s | green |
| 546 | web | `test-handoff-source-addresses.mjs` |  | 绿 | 19s | green |
| 517 | web | `test-image-preview.mjs` |  | 绿 | 11s | green |
| 518 | web | `test-inspector-attachments.mjs` |  | 绿 | 11s | green |
| 92 | web | `test-inspector-queue.mjs` | ✔ | 绿 | 13s | green |
| 99 | web | `test-inspector-shortcut-stack.mjs` | ✔ | 绿 | 13s | green |
| 98 | web | `test-inspector-shortcuts.mjs` | ✔ | 绿 | 0s | green |
| 97 | web | `test-key-chord.mjs` | ✔ | 绿 | 0s | green |
| 138 | web | `test-markdown-images.mjs` | ✔ | 绿 | 14s | green |
| 71 | web | `test-monitor-composer-dom.mjs` | ✔ | 绿 | 13s | green |
| 70 | web | `test-monitor-inspector-dom.mjs` | ✔ | 绿 | 34s | green |
| 69 | web | `test-monitor-inspector.tsx` | ✔ | 绿 | 1s | green |
| 43 | web | `test-monitor-wake.tsx` | ✔ | **红** | 1s | red → red |
| 515 | web | `test-native-agent-segments.mjs` |  | 绿 | 0s | green |
| 34 | web | `test-native-work-dom.mjs` | ✔ | 绿 | 17s | green |
| 32 | web | `test-native-work-metadata.ts` | ✔ | 绿 | 0s | green |
| 33 | web | `test-native-work-presentation.tsx` | ✔ | 绿 | 2s | green |
| 95 | web | `test-notes-delete-race.mjs` | ✔ | 绿 | 21s | green |
| 94 | web | `test-notes-empty-body.mjs` | ✔ | 绿 | 19s | green |
| 549 | web | `test-notes-filter.mjs` |  | 绿 | 0s | green |
| 93 | web | `test-notes-upload.mjs` | ✔ | 绿 | 14s | green |
| 520 | web | `test-open-in-ide-menu.mjs` |  | 绿 | 11s | green |
| 519 | web | `test-open-with-menu.mjs` |  | 绿 | 11s | green |
| 548 | web | `test-outbound-state.mjs` |  | 绿 | 0s | green |
| 120 | web | `test-page-interactions.tsx` | ✔ | 绿 | 4s | green |
| 26 | web | `test-page-token-delivery.mjs` | ✔ | 绿 | 3s | green |
| 100 | web | `test-palette-keys.mjs` | ✔ | 绿 | 0s | green |
| 101 | web | `test-palette-search.mjs` | ✔ | 绿 | 17s | green |
| 76 | web | `test-personal-cli-settings.mjs` | ✔ | 绿 | 13s | green |
| 110 | web | `test-preview-assist-ui.mjs` | ✔ | 绿 | 162s | green |
| 116 | web | `test-preview-error-toast.mjs` | ✔ | 绿 | 21s | green |
| 114 | web | `test-preview-log-live.mjs` | ✔ | 绿 | 54s | green |
| 117 | web | `test-preview-port-guide.mjs` | ✔ | 绿 | 14s | green |
| 115 | web | `test-preview-task-switch.mjs` | ✔ | 绿 | 13s | green |
| 107 | web | `test-preview-url.tsx` | ✔ | 绿 | 4s | green |
| 108 | web | `test-preview-workspace-launch.tsx` | ✔ | 绿 | 44s | green |
| 126 | web | `test-project-git-lifetime.mjs` | ✔ | 绿 | 18s | green |
| 77 | web | `test-project-member-role.mjs` | ✔ | 绿 | 12s | green |
| 109 | web | `test-project-settings-draft.mjs` | ✔ | 绿 | 19s | green |
| 150 | web | `test-provider-visibility.mjs` | ✔ | 绿 | 18s | green |
| 24 | web | `test-question-card.tsx` | ✔ | 绿 | 3s | green |
| 25 | web | `test-question-history-dom.mjs` | ✔ | 绿 | 35s | green |
| 534 | web | `test-queue-after.mjs` |  | 绿 | 0s | green |
| 38 | web | `test-remote-return.mjs` | ✔ | **红** | 35s | red → red |
| 37 | web | `test-remote-task.mjs` | ✔ | 绿 | 0s | green |
| 554 | web | `test-reply-drafts.mjs` |  | 绿 | 13s | green |
| 15 | web | `test-reply-quote.ts` | ✔ | 绿 | 0s | green |
| 124 | web | `test-reply-rail-dom.mjs` | ✔ | 绿 | 16s | green |
| 565 | web | `test-reply-resize.mjs` |  | 绿 | 13s | green |
| 105 | web | `test-reply-standing-executor.mjs` | ✔ | 绿 | 22s | green |
| 139 | web | `test-report-roots.mjs` | ✔ | 绿 | 0s | green |
| 529 | web | `test-review-diff-zoom.mjs` |  | 绿 | 13s | green |
| 56 | web | `test-review-lane-monitor-wake.mjs` | ✔ | 绿 | 0s | green |
| 55 | web | `test-review-presentation.tsx` | ✔ | 绿 | 1s | green |
| 141 | web | `test-review-report-boundary.mjs` | ✔ | 绿 | 0s | green |
| 143 | web | `test-review-report-claim.mjs` | ✔ | 绿 | 0s | green |
| 142 | web | `test-review-report-fallback.mjs` | ✔ | 绿 | 0s | green |
| 140 | web | `test-review-report-format.mjs` | ✔ | 绿 | 0s | green |
| 145 | web | `test-review-report-split-dom.mjs` | ✔ | 绿 | 15s | green |
| 146 | web | `test-review-report-summary-fold-dom.mjs` | ✔ | 绿 | 14s | green |
| 144 | web | `test-review-report-summary-fold.mjs` | ✔ | 绿 | 0s | green |
| 526 | web | `test-reviewer-profile-summary.mjs` |  | 绿 | 10s | green |
| 540 | web | `test-reviewer-turn-dom.mjs` |  | 绿 | 14s | green |
| 54 | web | `test-reviewer-turn.mjs` | ✔ | 绿 | 0s | green |
| 151 | web | `test-roving-choice.mjs` | ✔ | 绿 | 13s | green |
| 536 | web | `test-run-activity.mjs` |  | 绿 | 0s | green |
| 521 | web | `test-run-target-picker.mjs` |  | 绿 | 11s | green |
| 68 | web | `test-scheduled-message-reply.mjs` | ✔ | 绿 | 16s | green |
| 67 | web | `test-scheduled-message-tray-dom.mjs` | ✔ | 绿 | 17s | green |
| 66 | web | `test-scheduled-message-tray.tsx` | ✔ | 绿 | 1s | green |
| 562 | web | `test-scm-file-layout.mjs` |  | 绿 | 13s | green |
| 561 | web | `test-scm-nested-ui.mjs` |  | 绿 | 13s | green |
| 558 | web | `test-scm-paths.mjs` |  | 绿 | 0s | green |
| 560 | web | `test-scm-race.mjs` |  | **红** | 40s | red → red |
| 559 | web | `test-scm-stale.mjs` |  | 绿 | 13s | green |
| 82 | web | `test-segment-layout-dom.mjs` | ✔ | 绿 | 17s | green |
| 86 | web | `test-select-all-on-focus.mjs` | ✔ | 绿 | 14s | green |
| 20 | web | `test-selection-content.mjs` | ✔ | 绿 | 18s | green |
| 84 | web | `test-send-key.mjs` | ✔ | 绿 | 18s | green |
| 531 | web | `test-session-merge.mjs` |  | 绿 | 0s | green |
| 119 | web | `test-settings-card-fit.mjs` | ✔ | 绿 | 15s | green |
| 118 | web | `test-settings-path-jump.mjs` | ✔ | 绿 | 14s | green |
| 533 | web | `test-settle-created-task.mjs` |  | 绿 | 0s | green |
| 49 | web | `test-settlement-note.mjs` | ✔ | 绿 | 0s | green |
| 16 | web | `test-side-chat-browser.mjs` | ✔ | 绿 | 86s | green |
| 18 | web | `test-side-chat-direct-browser.mjs` | ✔ | 绿 | 20s | green |
| 17 | web | `test-side-chat-selection-browser.mjs` | ✔ | 绿 | 21s | green |
| 14 | web | `test-side-chat-state.ts` | ✔ | 绿 | 0s | green |
| 19 | web | `test-side-chat-upload.mjs` | ✔ | 绿 | 21s | green |
| 103 | web | `test-sidebar-navigation.mjs` | ✔ | 绿 | 18s | green |
| 104 | web | `test-sidebar-remote-race.mjs` | ✔ | 绿 | 23s | green |
| 550 | web | `test-slash-match.mjs` |  | 绿 | 0s | green |
| 547 | web | `test-spread-filter.mjs` |  | 绿 | 0s | green |
| 81 | web | `test-stick-to-bottom-dom.mjs` | ✔ | 绿 | 21s | green |
| 80 | web | `test-stick-to-bottom.mjs` | ✔ | 绿 | 0s | green |
| 60 | web | `test-system-notices-dom.mjs` | ✔ | 绿 | 18s | green |
| 63 | web | `test-task-catch-up-dom.mjs` | ✔ | 绿 | 32s | green |
| 125 | web | `test-task-creation-origin.mjs` | ✔ | 绿 | 20s | green |
| 72 | web | `test-task-memo-dom.mjs` | ✔ | 绿 | 22s | green |
| 544 | web | `test-task-mode-paging.mjs` |  | 绿 | 17s | green |
| 65 | web | `test-task-read-state.mjs` | ✔ | 绿 | 0s | green |
| 528 | web | `test-task-review-rounds.mjs` |  | 绿 | 13s | green |
| 535 | web | `test-task-sync.mjs` |  | **红** | 0s | red → red |
| 545 | web | `test-task-tree-offline.mjs` |  | 绿 | 13s | green |
| 543 | web | `test-task-tree-paging.mjs` |  | 绿 | 13s | green |
| 542 | web | `test-task-tree-preview.mjs` |  | 绿 | 14s | green |
| 541 | web | `test-task-tree.mjs` |  | 绿 | 0s | green |
| 524 | web | `test-team-review-inspector.mjs` |  | 绿 | 11s | green |
| 112 | web | `test-terminal-dock.mjs` | ✔ | 绿 | 15s | green |
| 537 | web | `test-tool-summary.mjs` |  | 绿 | 0s | green |
| 539 | web | `test-turn-fold-dom.mjs` |  | 绿 | 14s | green |
| 50 | web | `test-turn-fold.mjs` | ✔ | 绿 | 0s | green |
| 137 | web | `test-turn-images.mjs` | ✔ | 绿 | 0s | green |
| 62 | web | `test-turn-remedy-catch-up-dom.mjs` | ✔ | 绿 | 27s | green |
| 61 | web | `test-turn-remedy-dom.mjs` | ✔ | 绿 | 13s | green |
| 557 | web | `test-turn-retry.mjs` |  | 绿 | 0s | green |
| 79 | web | `test-ui-polish.mjs` | ✔ | 绿 | 12s | green |
| 58 | web | `test-upstream-retry-placement.tsx` | ✔ | 绿 | 1s | green |
| 74 | web | `test-users-role.mjs` | ✔ | 绿 | 15s | green |
| 73 | web | `test-withdraw-scheduled.mjs` | ✔ | 绿 | 16s | green |
| 556 | web | `test-workflow-edit.mjs` |  | 绿 | 0s | green |
| 555 | web | `test-workflow-rail.mjs` |  | 绿 | 0s | green |
| 553 | web | `test-workspace-history.mjs` |  | 绿 | 0s | green |
| 102 | web | `test-workspace-shortcuts.mjs` | ✔ | 绿 | 14s | green |
| 44 | web | `tsconfig.json scripts/test-monitor-wake-delivery.tsx` | ✔ | 绿 | 3s | green |
| 575 | web | `verify-git-workbench-busy-discard.mjs` |  | 绿 | 32s | green |
| 576 | web | `verify-git-workbench-design.mjs` |  | **红** | 17s | red → red |
| 573 | web | `verify-git-workbench-diff-prefixes.mjs` |  | 绿 | 45s | green |
| 572 | web | `verify-git-workbench-discard-menu.mjs` |  | 绿 | 46s | green |
| 577 | web | `verify-git-workbench-header-resize.mjs` |  | 绿 | 37s | green |
| 574 | web | `verify-git-workbench-refresh-paths.mjs` |  | **红** | 34s | red → red |