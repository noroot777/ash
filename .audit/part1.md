# 全量测试健康普查报告

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
