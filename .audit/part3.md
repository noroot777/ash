## 五 建议派单

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
