# 改名 navi ⑥：本地目录 harness → navi

把本机的仓库目录 `/Users/fjh/code/harness` 整个搬到 `/Users/fjh/code/navi`。这个目录不只是代码：服务的库、会话记录、上传的文件都在 `data/` 里，
库里、git 工作区里、各家 CLI 的会话目录和配置里到处记着它的绝对路径。脚本 `scripts/relocate-checkout.mjs` 把目录和这些记录一起换掉。

| 文件 | 管什么 |
| --- | --- |
| `scripts/relocate-checkout.mjs` | 入口：演练 / 真做 / 核对 / 退回 / 拿掉过渡链接 / 换远端 |
| `scripts/relocate-checkout-scan.mjs` | 清点（只读）：树、库、服务、进程、git 工作区、链接 |
| `scripts/relocate-checkout-agents.mjs` | 清点（只读）：各家执行器的会话目录、配置目录与配置文件 |
| `scripts/relocate-checkout-apply.mjs` | 真做 |
| `scripts/relocate-checkout-journal.mjs` | 账本（先记意图再动手）与退回 |
| `scripts/relocate-checkout-lock.mjs` | 迁移期间的维护锁（服务起不来，另一次迁移也进不来） |
| `scripts/relocate-checkout-paths.mjs` | 旧路径怎么认（边界）、怎么换 |
| `scripts/relocate-checkout-fs.mjs` | 读盘小工具：「不存在」与「读不动」分开 |
| `scripts/test-relocate-checkout.mjs` | 回归（挂在 `npm run test:accept-scripts` 里） |

## 操作单

前提：改名的 ①~⑤ 已经合进 main，主仓检出的是 main。下面的命令都照抄即可。

1. **停掉所有在这个目录里干活的东西。**
   - 界面里确认没有在跑的任务：等它们跑完，或者手动停掉。等哨兵的任务也算在跑。
   - 退出在这个目录里开着的 Claude Code / codex 会话、预览和 dev server、`expo start`。
     别的项目里的 Claude Code 会话也最好退出：它们会把 `~/.claude.json` 整份写回去，把脚本刚改的登记盖掉（脚本最后会核对，盖掉了重跑一次就行）。
2. **停服务**：`cd /Users/fjh/code/harness && npm run stop`。它说「会打断任务」而中止时，回第 1 步。
3. **演练**（只看不改）：
   ```sh
   cd ~ && node /Users/fjh/code/harness/scripts/relocate-checkout.mjs --from /Users/fjh/code/harness --to /Users/fjh/code/navi
   ```
   看输出里的 `✗`：服务没停、有任务或哨兵在跑、有进程的工作目录在树里、有读不到的东西（清点不完整）、配置改完会撞名，都会拦下真做。
   按提示处理完，再演练一次，直到结论行（最后一行）是「演练完毕」。
   标 `!` 的不拦真做，但会拦后面的核对与拆链接，要在那之前处理掉：
   - 停在树里的终端、命令行里带旧路径的 navi MCP：只是提示；
   - shell 配置、登录项、crontab 里的旧路径：脚本不改，自己改掉；
   - 认不出归属的 claude 会话目录：确认是这棵树的，加 `--claude-claim <目录名>`；不是的，加 `--claude-skip <目录名>`。
     后面每条命令都要带上同样的参数。2026-11-19 在本机演练时一个都没有。
4. **真做**：上面那条命令末尾加 `--apply`。大约十几秒。以退出码和结论行（最后一行）为准：
   - 退出码 0、「✓ 搬完了，记着旧路径的地方都换完了」：做完了；
   - 退出码 1、「✗ 搬完了，但还没完：…」：目录和记录都搬了，剩下的是要你处理的（多半是 shell 配置里的旧路径），处理完用第 7 步核对；
   - 退出码 2：预检拦下，什么都没动。
   - 中途失败（退出码 3）时，它会列出已经做完的步骤。两条路任选一条：
     - 修好原因，原样再跑一次 `--apply`。做过的步骤不会再做。
     - 退回：`node /Users/fjh/code/navi/scripts/relocate-checkout.mjs --from /Users/fjh/code/harness --to /Users/fjh/code/navi --rollback`
       （目录还没搬走时，把路径换成 harness 下那份）。
5. **装依赖、构建**（顺带把 ⑤ 合并后的步骤一起做了）：
   ```sh
   cd /Users/fjh/code/navi && npm install && (cd mobile && npm install) && npm run build
   ```
   用桌面预览手机端的话再跑 `npm run build:mobile`。
6. **启动**：照平时的方式，`npm run restart`。
7. **核对**：
   - `node scripts/relocate-checkout.mjs --from /Users/fjh/code/harness --to /Users/fjh/code/navi --verify`，退出码应为 0。
     还有要改的、要人处理的、读不到的，任何一类不为空都是 1，结论行里列着是哪些。
   - 界面里打开几条老任务：会话记录、贴过的图、审查证据的截图都要看得到。
   - 给一条做完的任务回一句话，确认它接着原来的会话说下去，工作目录是 `/Users/fjh/code/navi/.worktrees/…`。
   - 在 `/Users/fjh/code/navi` 里新开 Claude Code，确认长期记忆还在（`/memory`）。
   - `git worktree list`：所有工作区都在 navi 下面，没有 prunable。
8. **GitHub 上把仓库改名之后**，换远端：
   ```sh
   node scripts/relocate-checkout.mjs --from /Users/fjh/code/harness --to /Users/fjh/code/navi --set-remote
   ```
   它先确认新地址连得上才改。GitHub 上还没改名时，它会拒绝，什么都不动。
9. **过几天**，确认没有东西再用旧路径之后，拿掉过渡链接：同一条命令换成 `--unlink`。
   它的判据是核对干净（同上一条），并且没有进程的命令行里还带着旧路径。不满足就不拆，并列出卡在哪。

mac 应用不受这次搬家影响：Ash.app / Navi.app 跑的是自带的服务，数据根不在仓库里，登录项 `dev.ash.server` 也不指向仓库。
要重装 mac 应用（⑤ 交接里的 `desktop/macos/build.sh --install`），在新目录里跑。

局域网里那台 Windows（`D:\ai_workspace\ash`）不在这次范围内：它的目录、库、会话都在那台机器上，这里不碰。

## 脚本做了什么

所有改写都是「旧根 → 新根」的前缀替换，难点在边界：
- 后面紧跟任何文字的字母数字，或者 `_ - ~ @ + %`，是别的目录，一个字节都不碰：`harness-old`、`harness2`、`harness中文`、`harness@x`、`harness.bak`。
- 磁盘上真有的、名字是「harness + 空格或标点」的兄弟目录（访达复制出来的 `harness copy`、`harness 2`），逐个列出来排除。
- 整个值就是一条路径时（库里的路径列、JSON 的键），后面接着目录名里也能有的 ASCII 标点（`harness:2`、`harness(1)`）也算别的目录。
- `/Volumes/x/Users/…` 这类出现在别的路径中间的也不碰。
- 句末的 `harness。`、`harness，`，JSON 转义过的 `\n/Users/…`，`file://` 后面的，以及前面紧挨汉字的（「截图目录/Users/…」），照常换。
  前面紧挨汉字这一条是拿真库量过才定的：39 处全是这种正文，没有以中文目录名结尾、再接 `/Users/…` 的相对路径。
- 后面紧跟非 ASCII 文字、又对不上任何兄弟目录的（真库里 1 处，「…/harness对…」），分不清是正文还是别的目录，不改，演练时报出数量。

| 哪里 | 怎么改 | 为什么非改不可（实测） |
| --- | --- | --- |
| 目录本身 | 同一个文件系统里一次 `rename`，不复制 | 不同文件系统时拒绝 |
| git 工作区两头 | 仓库里的 `.git/worktrees/<名>/gitdir`、工作区里的 `.git` 文件，直接改这两份（等价于 `git worktree repair`，好记账、好退回）。绝对路径换前缀；`--relative-paths` 登记的相对路径按 git 的基准（文件所在目录）解析，再按新位置重算成相对路径。树里的嵌套仓库、登记在树外的工作区都算 | 不改的话 git 认不出工作区；服务端看工作目录不在，会给任务重建一个空工作区 |
| 树里的绝对链接 | 指向旧根的改指新根（工作区借主仓 `node_modules` 的那批，本机 2026-11-19 下午 286 个） | 留着过渡链接时也能用，但拆链接那天就全断 |
| navi 的库 | 所有表所有文本列，一个事务；BLOB 不碰，`updated_at` 不碰（侧栏顺序不变）；撞上唯一约束整份不改。动手前先 checkpoint（WAL 模式的库把日志并回主文件），备份的才是完整的一份；checkpoint 被别的连接挡住就不动 | 任务、会话、哨兵、验收、上传附件的路径都按绝对路径存。服务端按此刻的 `data/uploads/` 前缀认正文里的附件 |
| `data/skill-calibrations.json` | 键里的工作目录 | 技能校准按「执行器 + 工作目录」记 |
| claude 会话目录 `<配置目录>/projects/<路径名>` | 改名；目标已有就逐项并进去（同名且内容不同就整次拒绝）。所有已认领目录里的长期记忆 `memory/**/*.md` 正文里的路径一起换。目录名是有损编码（`harness-old`、`harness/old`、`harness中文` 可以换出同一个名字），所以只凭证据认领：会话记录里的 cwd 在树里；子目录名是树里某个会话的会话号（子代理、工作流目录）；名字正好是树里登记过的路径；或者用 `--claude-claim` 点名。其余的不动 | claude 2.1.283 按会话号续跑时会跨目录找，不改名也能续上。但长期记忆按**新目录名**找（工作区的记忆也落在主仓那个目录名下），服务端接力按新路径算目录名找会话文件 |
| grok 会话目录 `~/.grok/sessions/<编码后的路径>` | 改名 | 见下面「没能验证的」 |
| opencode 的库 | `session.directory`、`workspace.directory` | 目录不在了续跑直接报 `FileSystem.realPath … ENOENT`（实测），改了这一列就续上 |
| codex | 不改 | 按会话号 `thread/resume`，用起跑时给的新工作目录（实测） |
| CLI 配置 | 每个 claude 配置目录（`~/.claude`、`CLAUDE_CONFIG_DIR`、库里会话登记的、个人档 `data/user-cli/<人>/claude`）的 `.claude.json` 与 settings；每个 codex 配置目录（`CODEX_HOME`、库里登记的、个人档）的 `config.toml`；opencode / grok / gemini / qwen / kimi / cursor 的配置，有就改。配置是指向别处（dotfiles）的链接时，链接原样留着，改它指着的那份，权限照旧；链接指进树里的，改指新位置。JSON 的键改完会撞上已有的键时整份不改、拦下真做 | 服务端对已有的 MCP 登记一律不覆盖，旧路径会一直指着旧位置 |

**不改的**：
- 会话原始记录（`data/runs/**`、claude 的 `*.jsonl`、codex 的 rollout）。它们是只追加的日志。库里记着读到第几个字节（`sessions.agent_offset`），改了长度续读就错位。
  界面按路径的形状认图片（`…/data/runs/…`、`…/data/uploads/…`），旧路径照样显示。
- 库文件名 `ash.db`。改名要连锁和账本一起挪；mac 应用的「导入已有数据」按 `ash.db` 找；回退到旧版会对着空库起来（见 `server/src/db/path.ts`）。
- shell 配置、登录项、crontab：只列出写着旧路径的行，自己看着改。

**拦下真做的预检**：
- 服务还在：单例锁（`.navi.lock` / `.ash.lock`）或在线登记（`.navi-online.*` / `.ash-online.*`）的进程还活着，有进程开着库文件，或者别的进程拿着维护锁（另一次迁移、离线回填）。
- 库里有 running / queued 的任务，或者有在盯的哨兵。
- 有进程的工作目录在树里。本脚本自己和它的上级 shell 不算；纯交互 shell 只提示。
- 清点不完整：lsof / ps / find 没跑成，目录列不了，锁或登记读不懂。不知道谁在用，不当成没人用。
- 配置或数据文件改完会撞名。
- claude / grok 会话目录合并时撞上内容不同的同名文件。
- 目标已存在，或者不在同一个文件系统上。

**维护锁**：`--apply` 和 `--rollback` 先拿锁，再在锁里清点一遍，这一遍过了预检才动手，做完放掉。
锁的文件格式与服务端离线维护锁相同（`<库>.maintenance.lock`、`<runs>.maintenance.lock`，「查对方 + 建自己」在 `.navi-claim.lock` / `.ash-claim.lock` 里做），服务起手时看得见它、起不来。
脚本被杀之后锁自动失效：判据只有 pid 和进程启动时刻。

**账本与退回**：每次 `--apply` 在 `~/.navi-relocate/<时间>/` 记一份账本，改文件之前把原样（连同权限）存进同目录的 `backup/`。
每个动作都是先把「怎么退回它」落盘，再动手，再记完成。磁盘写满、进程被杀发生在任何时刻，账本里都有这一步。
`--rollback` 把这对路径下还没退回完的账本从新到旧全退。每个退回动作先看盘上此刻的样子，已经是原样的就跳过，所以「记了意图、其实没做」的那一步退回时什么都不做，退回做到一半中断也能接着重跑。
库和配置整份换回备份，所以只能在**启动服务之前**退；起过服务之后，服务写进库的东西会被盖掉，那时只能往前修。

## 过渡链接：留，过几天再拆

默认在旧位置留一个 `harness → navi` 的相对链接（`--no-link` 不留）。

**留的理由**：脚本够不着的地方照样能用旧路径。比如：
- 别的会话已经拉起的 navi MCP 进程；
- 终端里停在旧目录的 shell；
- 你的别名、编辑器的最近项目；
- 正在续跑的 agent 记忆里写着的旧路径（它照旧 `cd` 过去也能落到同一个地方）。

**留着会不会把东西分成两份**，逐项查过：
- claude 在链接路径下起跑时，会话目录和长期记忆都按真实路径落在新名字下（实测，见下）。
- navi 按物理路径认项目（`repoKey`），拿旧路径来 resolve 项目会落到同一个项目上，不会建出重复项目。
- node 按真实路径加载入口，从旧路径启动服务，数据目录照样是新的那份。

**拆的理由**：链接会把残留藏起来。所以 `--unlink` 只在 `--verify` 干净时才拆：没有要改的、没有要人处理的（认不出的会话目录、shell 配置里的旧路径、指到树外的相对链接）、没有读不到的，也没有进程的命令行里还带旧路径。

## 覆盖不到、要你手动处理的

- 写着旧路径的 shell 配置、登录项、crontab：演练时逐行列出（本机目前没有），不改掉就过不了核对。
- 认不出归属的 claude 会话目录：见操作单第 3 步。
- 换了上级目录时，树里指到树外的相对链接会断：列出来，不改（这次 harness 和 navi 在同一个上级目录，没有这种）。
- 脚本扫描范围之外的、指向旧路径的链接（比如 `/usr/local/bin` 里你自己建的）：拆过渡链接之前自己找一下。
- 编辑器 / 终端的最近项目、IDE 工作区设置。
- 已经在跑、命令行里带旧路径的 navi MCP 进程：留着链接时照常工作，那些会话重开一次就换成新路径。
- 接力（handoff）给别的机器时，按此刻 `data/uploads/` 的绝对前缀找附件。只在**旧会话原始记录**里引用过、正文里没有的附件，打包时会漏掉（库里的正文已经换了，不受影响）。
- GitHub 仓库改名本身。
- Windows 那台。

## 没能验证的

- **grok**：本机没登录（`Not signed in`），最后一次用是 9 月，也没有未完成的 grok 任务。脚本按它的目录编码规则改了名、解码回来逐个核对过，但没能真跑一次续跑。
- **kimi 等其余执行器**：这个目录下没有它们的会话，脚本不处理。
- **真实目录上的执行**：按任务要求没在真目录上做。真目录上只跑了演练（只读，库用的是在线备份），结果见下。

## 验证记录（2026-11-19）

### 1. 各执行器搬目录后能不能续跑（一次性目录 `/private/tmp/navi-exp`，真 CLI）

先在 `…/harness/.worktrees/T*` 里起会话、记一个暗号，再把目录 mv 成 `…/navi`，从新目录续跑：

| 执行器 | 结果 |
| --- | --- |
| claude 2.1.283 | 不改会话目录名也续得上（`--resume` 会跨目录找），续跑写进旧名目录；长期记忆另起在新名目录下 → 记忆要搬 |
| claude（在链接路径下起跑） | 它的 Bash 看到的是链接路径，但会话目录和记忆目录都按真实路径落在新名下 |
| codex 0.153.4（app-server，与 navi 同一协议） | `thread/resume` 按会话号续上，新工作目录生效，不用改它的记录 |
| opencode 1.19.3 | 不改续跑报 `FileSystem.realPath (…/harness/.worktrees/T4) ENOENT`；只改 `session.directory` 后续上，记得暗号，pwd 是新目录 |

### 2. 副本 A：真数据全量

搭法（脚本留在演练目录，用完已删）：
- 整个仓库目录写时复制克隆（16G，含 `data/`、15 个工作区、`node_modules`）。
- 库用 sqlite 在线备份取一份一致的拷贝。
- 假家目录：拷入 287 个 claude 会话目录（2.6G，含 73 份长期记忆）、10 个 grok 会话目录、opencode 库、`~/.claude.json`、codex 与 opencode 配置。
- 所有绝对路径用 sed / SQL 改到副本位置。没用 `git worktree repair`：拷贝来的工作区指着真仓库的登记，repair 有可能顺着去改真仓库。
- 把副本库里在跑的任务改成 paused（模拟操作单第 1 步）。

在副本树里起 shell 跑 `--apply`（跟用户在仓库根目录跑一样），10 秒做完：
- 31 份工作区路径文件；
- 580 个链接；
- 库里 37496 个值；
- 287 个 claude 目录；
- 10 个 grok 目录；
- 31 条 opencode 会话；
- 3 份配置。

再用一份**不复用脚本代码**的 Python 核对，全部通过：
- git：885 条引用前后一致；`git worktree list` 与搬前一致；16 个检出的 HEAD、未提交改动数、顶层目录都对。
- 库：74 张表行数不变。变了的每一个值都恰好是「旧根 → 新根」（加上 claude 目录名、触发器自增的修订号）。旧根剩 0 处。
- 库里的路径列逐列核对，指向树里、磁盘上真存在的条数搬前搬后相同。比如：
  - `sessions.cwd`：103/3565；
  - `regression_checks.log_path`：1930/1938；
  - `task_writes.path`：606/2185。
- claude：旧名目录一个不剩，新名 287 个，73 份记忆都在，记忆正文里没有旧根。
- grok 和 opencode：都换成了新位置。
- `~/.claude.json`：结构与「搬前 + 旧根 → 新根」完全一致。
- 树里没有指向旧根的链接。

**退回**：`--rollback` 4 秒，退回后：
- 库和 `~/.claude.json` 与搬前逐字节一致（`cmp`）；
- 工作区登记一致；
- 287 个会话目录回到旧名；
- 580 个链接指回旧根。

**再做一次之后**：
- `npm install`、`npm run build` 在新位置通过。
- 预览模式起服务（起之前清掉拷贝来的清理欠账，见下面的注意）。接口核对：
  - harness 项目的 `repoPath` 是新位置，项目健康 `exists / isRepo` 都为真；
  - 别的项目路径没变；
  - 在跑任务的 `/workspace` 指向新工作区；
  - 会话记录和轨迹读得出；
  - 正文里引用的上传图片返回 200 / image/png；
  - 首页 200。

### 3. 副本 B：真跑一轮 → 搬 → 再跑一轮

- 克隆仓库，检出本分支。数据目录为空，只从迁移前的库拷贝里播种设置表（执行器、模型供应商），家目录全新。
- 在旧位置起服务，建 claude / codex / opencode 三条用工作区的任务，各记一个暗号、执行 pwd。
- 停服务，`--apply`，再 `--unlink` 把过渡链接拆掉，证明不靠链接。
- 在新位置起服务，三条各回复一句。

结果：
- 三条都在**同一个 navi 会话、同一个 CLI 会话号**上续跑，答出了各自的暗号（KESTREL / OSPREY / PLOVER），pwd 是 `…/navi/.worktrees/<任务号>`。
- claude 写进的是改名后的会话目录，没有冒出旧名目录。
- codex 自己往配置里加的项目信任条目也换了。

上面 1~3 是在第 1 轮审查之前那一版上做的。审查之后的改动（见下面第 5 节）没有重做副本 A、B，证据是第 4 节的回归、第 5 节的核对和真目录演练。

### 4. 回归

`node scripts/test-relocate-checkout.mjs` 16 条。
- 边界规则：中文名、空格后缀的兄弟目录，整条路径后面接标点，前面紧挨汉字的正文。
- JSON 键改完撞名时两份都原样留着。
- 演练不改任何东西；认不出归属的 claude 目录列出来、不动。
- 预检拦截：有任务在跑、有进程在树里、配置改完会撞名、lsof 跑不成（清点不完整）、别的进程拿着维护锁、目标已存在。
- 账本写不进去（注入 ENOSPC）：意图落不了盘时目录不动；动完之后落不了盘时，`--rollback` 照样找到这一步、退回原样。
- 中途失败（在树里起跑）后重跑接着做完；结论在最后一行。
- 搬完后的逐项核对，包括：
  - 嵌套仓库、树外工作区、`--relative-paths` 登记的树外工作区；
  - WAL 模式的库、WITHOUT ROWID 表、BLOB；
  - 兄弟目录（`harness-old`、`harness中文`、`harness copy`）不动；
  - 按会话号认领的工作流目录、合并已存在的会话目录、工作区自己的长期记忆；
  - 个人档里的 claude / codex 配置与会话目录；
  - 指向 dotfiles 里 0600 文件的配置链接：链接还在、权限照旧；
  - 维护锁放掉了。
- 核对：shell 配置里还有旧路径时不算完；改掉之后干净；再跑一遍什么都不做。
- 退回到逐字节一致（链接、权限都是原样）。
- `--no-link`：树外工作区不靠链接也认得；个人档的配置第一遍就改到。
- `--unlink`：认不出的会话目录、shell 配置里的旧路径都会拦下，处理完才删。

### 5. 第 1 轮审查之后

- **锁和在线服务的兼容**：在临时目录里用脚本拿锁，再用主仓里在线服务那份构建（`server/dist`）自己的判据去查：
  - `liveMaintenanceHolderForAny` 认出了这把锁（服务起手 `acquireDbSingletonLock` 用的就是它）；
  - 服务端 `acquireMaintenanceLocks` 被挡下（`MaintenanceLockError`）；
  - 两边算出来的资源键相同；
  - 放锁后查不到。
  没能用真服务进程起一次来验：主仓此刻的 `server/dist` 和 shared 的产物版本对不上，`node server/dist/index.js` 在加载模块时就报错（与锁无关；`npm run restart` 会先构建）。
- **真目录上的演练**：结果见下。

### 真目录上的演练（只读）

2026-11-19 在 `/Users/fjh/code/harness` 上跑了两次演练（库用在线备份）。第 1 轮审查之后那次（下午）：
- 读不到的 0 处，认不出归属的 claude 会话目录 0 个。289 个都有证据，其中 4 个没有会话记录的工作流目录按会话号认出来了。
- 配置没有改完会撞名的。
- 工作区登记 17 个，要改的路径文件 34 份，指向旧位置的链接 286 个。
- 库里旧路径 40174 处；另有 1 处后面紧跟文字、不改。
- claude 会话目录 289 个，grok 10 个，opencode 31 条，配置 3 份（同下表）。
- 6 个任务在跑、22 个进程在树里，所以拒绝真做。

审查之前那次（中午）的清单：

| 项 | 数量 |
| --- | --- |
| 工作区登记（其中 1 个在 `/private/tmp/navi7` 树外） | 16 个 |
| 要改的工作区路径文件 | 31 份 |
| 指向旧位置的链接 | 580 个 |
| 库里的旧路径 | 39960 处，分布在 44 个列 |
| claude 会话目录 | 287 个 |
| grok 会话目录 | 10 个 |
| opencode 会话 | 31 条 |
| 配置 | `~/.claude.json`、`~/.codex/config.toml`、`~/.config/opencode/opencode.jsonc` |

当时有 5 个任务在跑、18 个进程在树里干活，所以它拒绝真做——这正是预期的。

**拿库的拷贝起服务时碰到的事**：拷贝来的库里有「清理欠账」，记着**真实进程**的 pid。第一次在副本上起服务时没清它们，副本服务去追了三个真实进程（IINA、一个 python、cdp-proxy）。
它判定这个平台给不出下刀的落点，什么都没动，三个进程事后都还活着。之后副本 A 起服务之前先清空了 `agent_cleanup_debts`、`monitor_reclaim_debts`，并把 `sessions.agent_pid` 置空；副本 B 是只播种设置表的空库，本来就没有这些。
