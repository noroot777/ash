# 把 ash 装到别人的机器上

两件事:**你这边打包**、**他那边执行**。

---

## 一、你这边:打包

```bash
npm run package                 # 产物落 dist-package/ash-<日期>-<sha>.tar.gz
FORMAT=zip npm run package      # 改打 .zip(收件人是 Windows 时更省事:双击就能解)
```

格式默认跟着**打包机**走(Windows 上默认 zip,其余默认 tar.gz),`FORMAT=` 可以明写。两种都由 `git archive` 直接产出,没有第三方打包器;没做安装器(MSI/NSIS)——包解开之后还要 `npm install` + 构建,不是「装完即用」的形态,签名/卸载/升级三条链路的代价换不来对应的便利。

打的是 `git archive HEAD`,所以包里**只有入库的文件**。这几样不可能混进去:

| 不进包 | 为什么 |
|---|---|
| `data/` | SQLite 库 —— 里面有你的 LLM 供应商 **API key**、全部任务正文、会话记录、上传的图 |
| `node_modules/` | 平台相关(node-pty 是原生模块),必须在对方机器上装 |
| `.worktrees/` | 你本地的任务工作区 |
| `*.log` / `dist/` | 构建产物与日志,对方自己构建 |

脚本会打出 SHA256,可以一并发过去核对。工作区有未提交改动时会提醒你——**未提交的东西不会进包**。

也可以直接给 git 仓库地址(如果对方有权限访问),`git clone` 等价,而且以后 `git pull` 就能升级。tar 包适合「对方拿不到你的仓库」的场合。

> 想连历史一起给、又没有共享 remote:`git bundle create ash.bundle --all`,对方 `git clone ash.bundle ash`。

---

## 二、他那边:执行

### 0. 前置(必须先有)

| 依赖 | 要求 | 说明 |
|---|---|---|
| **macOS / Linux / Windows** | — | 三个平台都能原生跑,Windows 不需要 WSL2(脚本全是 `.mjs`,系统调用按平台分了实现) |
| **Node.js** | >= 22.16.0,建议 24 | `node -v`。数据库用的是 Node 内置的 `node:sqlite`,22.16 之前那几个版本要么没这个模块、要么缺 `setReturnArrays`;`node scripts/setup.mjs` 会当场实测,不是比版本号 |
| **git** | 任意近版 | worktree 隔离、审查 diff、验收合并全靠它 |
| **至少一个 agent CLI** | 已安装**并登录过** | 见下 |

ash 是**调度台**,自己不写代码——它拉起 `claude` / `codex` 这类 CLI 去干活。所以对方机器上必须有至少一个,并且**已经登录过一次**(ash 用的是这些 CLI 自己的登录态,不需要在 ash 里填 API key):

```bash
npm install -g @anthropic-ai/claude-code   &&  claude    # 登录一次
npm install -g @openai/codex               &&  codex     # 登录一次
```

界面「设置 → 执行器」里有完整目录(gemini / cursor / opencode / qwen / copilot …)和各自的官方安装命令。

### 1. 解包并一键安装

```bash
tar xzf ash-<日期>-<sha>.tar.gz
cd ash-<日期>-<sha>
node scripts/setup.mjs
```

> 拿到的是 `.zip` 就换成资源管理器右键「全部解压缩」,或 PowerShell 里 `Expand-Archive ash-<日期>-<sha>.zip .`;后面两条命令一样。

这一条命令做了 5 件事:检查环境 → `npm install` → `npm run build` → **接上 ash MCP** → 列出可派活的 CLI。幂等,重复跑不会重复写配置。

可选开关:`PORT=4317`(换端口)、`SKIP_MCP=1`(不动 CLI 配置)、`SKIP_BUILD=1`。

### 2. 起服务

```bash
npm start            # 前台跑,Ctrl-C 停
# 或
npm run restart      # 构建 + 后台常驻,日志 /tmp/ash-4317.log(Windows 是 %TEMP%\ash-4317.log)
```

浏览器开 **http://localhost:4317** —— 同一个端口既是界面也是 API。

> Windows 上这几条命令在 PowerShell / cmd 里直接跑就行(`tar` 自 Windows 10 1803 起是系统自带的)。唯一要留意的是**换行符**:仓库里的 `.githooks/*` 是 shell 脚本,由 Git for Windows 自带的 bash 执行,`git config core.autocrlf` 设成 `input` 或 `false`,别让它们被转成 CRLF。

### 3. 第一次用

1. **新建项目**:填一个 git 仓库的**绝对路径**(ash 就在这个仓库里派活)
2. 新建任务 → 选执行器 → 跑

执行器列表为空也能跑:不选就用该 CLI 的默认配置。想固定模型/思考强度再去「设置 → 执行器」建 profile。

---

## 三、MCP 那一步为什么不能省

ash 里的 agent 是靠 **ash MCP 的 `complete_task`** 交卷的:回合结束时没有这个确认,任务一律按未完成记成 `failed`(exit 0 ≠ done)。MCP 没接上 = agent 压根没有那个工具可调 = **每个任务跑完都是红的**。

`setup.mjs` 已经自动接好了。手动接的话:

```bash
# claude(user 作用域,编排别的仓库时也在)
claude mcp add ash --scope user \
  -e ASH_URL=http://localhost:4317 \
  -- node /绝对路径/ash/mcp/dist/index.js

# codex:追加到 ~/.codex/config.toml
[mcp_servers.ash]
command = "node"
args = ["/绝对路径/ash/mcp/dist/index.js"]

[mcp_servers.ash.env]
ASH_URL = "http://localhost:4317"
```

路径必须是**绝对路径**,而且指向解包后的那份 `mcp/dist/index.js`(所以要先 build)。改了端口,这里的 `ASH_URL` 要一起改。

验证:`claude mcp list` 应该看到 `ash: … ✔ Connected`。

### 其它 CLI(gemini / grok / kimi / opencode / cursor / qwen / qoder / copilot / kiro / kilo / antigravity / pi / trae)

`npm run setup` 会给**这台机器上真装了**的每一家都写一条 ash 登记,落点和格式各不相同
(逐家一张表在 `server/src/executors/catalog/README.md` 的「ash MCP 登记矩阵」,表本体是代码:
`server/src/mcp-registry/catalog.ts`)。规矩一样:

- **只在缺 ash 条目时追加**,其它条目(含你自己装的第三方 MCP)一个字节都不动;
- 已有 `ash` 或历史名 `harness` 一律不覆盖,关着的不替你打开,那个键的值我们认不出来时也不动;
- 落盘走**文本插入**:只把 ash 那一条插进去,其余字节(你的注释、缩进、键序,以及像
  `9007199254740993` 这种超出 JS 安全整数的数字原值)全部原样保留。所以带注释的
  `opencode.jsonc` 一类现在也能自动补接;
- 改写已有文件前生成 `.bak-ash-setup` 备份(**写完会读回来跟原文逐字节核对**,核不上就什么都
  不写)。这份备份跟上面那个临时文件一样是**独占新建的**:那个名字上要是已经有东西(一条软
  链接、一个目录,或者上一次留下的备份),ash 既不覆盖它也不跟着它写,而是换成
  `.bak-ash-setup-<随机段>` 再建 —— 所以同一份配置被反复改写时你会看到好几份备份,它们都是
  按时间叠上去的旧版本。备份一律按 `0600` 建(它装着跟配置同一份内容);
  而且**写盘那一步是个事务**,顺序是:先在同目录独占新建一个随机名的临时文件、把这份
  正文写进去 fsync 一次(写不动、没空间、挂载是只读的,都在这一步收手,**你那份一个字节都没
  碰**)→ 留备份 → **紧贴写盘再确认一次盘上还是刚读到的那一版**(免得盖掉你同时存的改动)
  → 就地写 → 读回来比对。慢的那几步全排在最后那次确认之前,所以「你刚存的改动被旧快照盖掉」
  的窗口只剩写盘前那一瞬;
  - 就地写(而不是「临时文件 + 改名」)是为了保住这份文件的身份:Windows 的 DACL、POSIX 的
    扩展 ACL、硬链接、软链接目标,改名换上去的新文件都带不过去。代价是**没有原子替换**,有
    两档兜不住、会在活动配置上留下半截:① 写到一半断电或进程被杀;② 只有这个文件自己坏掉的
    持续故障(同目录预演过得去、写它一直报 I/O 错,连回写旧正文也失败)。两档都拿
    `.bak-ash-setup` 拷回去还原 —— ash 的话术会直接告诉你活动那份坏了、备份在哪;
  - 这套事务**起跑时自动补登记那条路也走**(不只是 `npm run setup`):那条路原来一份备份都
    不留,现在同样留 `.bak-ash-setup`;
- 新建的那份配置按 `0600` 建(只有你自己读得到);已有文件就地写,权限一个位都不动;
- TOML 那一族(grok)**认得出你已经装过的第三方 MCP**,会接在它后面;判不准那份配置的写法时
  一个字都不写,拼好之后还会自己再扫一遍、确认恰好只有一张 ash 表才提交(TOML 里重复一张同名
  表会让 CLI 整份配置都读不出来,连你自己的 MCP 一起没了);
- **一家 CLI 会读好几份配置时,判的是「几份合起来最终生效的那一条」**。opencode 这边 2026-10-31
  用真 CLI 逐格实测过四层来源,优先级从低到高:默认目录(`opencode.json` 和 `opencode.jsonc`
  **两份都读**,而且 `.jsonc` 压得住 `.json`)→ `OPENCODE_CONFIG` 指的那个文件 →
  `OPENCODE_CONFIG_DIR` 再加的那个目录 → `OPENCODE_CONFIG_CONTENT` 里那整段 JSON。
  合并是**逐字段**的:全局那份写完整的启动命令和环境变量、高优先级那份只写一句
  `"ash": {"enabled": true}`,真 CLI 用的是两份合起来那一条(照样 `ash connected`),所以
  setup 不会再往别处补一条,搬进隔离档的也是**合完**那一条(只搬高优先级那份的话,隔离档里
  就只剩一个 `enabled` 键,真 CLI 在那边打印 `No MCP servers configured`);反过来,
  **高优先级那份只写一句 `"ash": {"enabled": false}` 也会把全局那条完整登记关掉**(真 CLI 报
  `ash disabled`),那种情况 ash 只如实说「被关着」、不替你打开。另外两条实测结论:一条登记
  **没写 `type` 就不是服务、只是个开关**(单独一句 `{"enabled": true}` 真 CLI 当没有),而
  `disabled: true` 这个键 opencode 压根不认(那是 claude 那一族的写法),ash 遇到它只说看不准。
  `OPENCODE_CONFIG_CONTENT` 是只读来源(没有文件可写),它里面有 ash 时 ash 一个字都不写。
  kilo 的 `KILO_CONFIG` 形状一样但没真 CLI 可问,几份结论不一致时 ash 只说「看不准」、不写也不
  拦你起跑。

装完某家 CLI 之后重新跑一次 `npm run setup` 就会补上。两处例外值得单说:

- **trae**:它的原生配置是 YAML(`traecli config edit` 打开 `~/.trae/traecli.yaml`),本仓没有能保住
  注释与缩进的 YAML 写入器 —— 但它同样扫描标准的 `mcpServers` JSON,所以 ash 写的是
  `~/.trae/mcp.json`。**如果那个目录里已经有 `traecli.yaml` / `mcp.yaml` / `.mcp.yaml`,ash 一个字
  都不写也不下结论**(你可能已经把 ash 写在那里面了,而两份配置里各有一条同名登记、谁生效没有
  文档依据):那种情况请按原生格式自己加一条。
- **copilot**:它的 MCP 子进程**只自动继承 `PATH`**(官方文档明写其余环境变量必须配在那条登记的
  `env` 里),而 ash 的回合身份一轮一个值、写死进配置文件就是过期的假身份。所以身份走**一份文件**:
  ash 每回合在 `data/runs/<任务 id>/turn-identity/<回合令牌>/identity.json` 放一份、把那个目录追加到
  `PATH` 末尾(目录里只有那份 json、没有可执行文件,盖不掉你的任何命令;文件 0600,换回合就把上一份
  删掉),MCP 侧在环境变量都不在时读它。**不用你配任何东西**,登记里也不会出现任何身份字段。
  这条桥本机没装 copilot、没法实测:万一它连 `PATH` 也改写,表现就回到「交卷被拒」,那时需要交卷的
  任务请换别的执行器。预检每轮都会把这一句说出来。

接没接上不用自己猜:起跑前的预检会在任务时间线上说一句(确实没有 MCP 机制的直接拒掉派审,
只按文档核对过、没在真机实测的那几家会明说这一点,已知「写了也交不了卷」的会把原因说出来),
ash 启动时也会把缺口逐家列在日志里。

### Kimi Code

安装并运行 `kimi login` 登录后，重新运行 `npm run setup`，会把 ash MCP 登记到
`~/.kimi-code/mcp.json`（设置了 `KIMI_CODE_HOME` 时使用该目录）。

手动配置时，把下面的 `ash` 条目合并进该文件的 `mcpServers`：

```json
{
  "mcpServers": {
    "ash": {
      "command": "node",
      "args": ["/绝对路径/ash/mcp/dist/index.js"],
      "env": { "ASH_URL": "http://localhost:4317" }
    }
  }
}
```

在“智能体”里添加 Kimi Code 执行器即可用于普通任务和团队执行者（暂不支持常驻调度台）。
模型列表来自 `kimi provider list --json`；智能水平按模型能力提供，通过进程环境注入，
不改用户的 `config.toml`。Kimi 的 stream-json 不包含思考正文，因此时间线只显示回答和工具调用。
默认模型或模型能力无法确认时，智能水平仅可跟随 CLI；明确选择已知模型后才可覆盖档位。
Kimi Code 账号需有可用的编码订阅；403 订阅错误会显示在任务中，不代表 CLI 未安装。

---

## 四、日常运维

**升级**:`git pull`(或换个新 tar 包解到旁边)后 `npm install && npm run restart`。库会在启动时自动补列迁移,不需要单独跑迁移命令。

**数据与备份**:全在仓库里的 `data/`——`ash.db`(SQLite)+ `runs/`(每轮的正文、trace、验证证据)+ `uploads/`。备份就备份这个目录;换机器把它整个拷过去即可。`data/` 不入库,所以你发出去的包永远不含对方不该看的东西,反过来对方的数据也不会被你的包覆盖。

**环境变量**:

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `4317` | 服务端口 |
| `ASH_DB` | `<仓库>/data/ash.db` | 库文件位置 |
| `ASH_LOCAL_OPEN_ROOTS` | 作者机器上的两个路径 | 「在本机打开文件」允许的根目录,冒号分隔。**换机器基本都要重设**,否则这个功能不可用 |

**常驻**:`npm run restart` 用 detached spawn 起进程,关掉终端也活着。想要开机自启就自己包一层 launchd(macOS)/ systemd(Linux)/ 计划任务(Windows,触发器选「登录时」),`ExecStart` 写 `node <仓库>/server/dist/index.js`,`WorkingDirectory` 写仓库根。

**只能起一个**:同一个库上有单例锁,第二个实例会拒绝启动并告诉你谁占着。想再起一个隔离实例:`PORT=4318 ASH_DB=/tmp/x.db npm start`。

---

## 五、排错

| 症状 | 多半是 |
|---|---|
| 任务跑完全是 `failed`,日志里没报错 | MCP 没接上(见第三节),agent 无法调 `complete_task` |
| 起不来,说端口被占 | 已经有一个实例在跑:`lsof -nP -iTCP:4317 -sTCP:LISTEN`(Windows:`Get-NetTCPConnection -LocalPort 4317 -State Listen`) |
| 界面打得开但一片空白/样式旧 | `web/dist` 没构建或过期:`npm run build`(server 从磁盘读 dist,**不用重启**) |
| 派任务立刻 ENOENT | 那个 CLI 没装,或不在 server 进程的 PATH 里(从 GUI 启动的进程 PATH 常常更短——用终端起服务) |
| `npm install` 卡住/失败 | 网络或 registry;node-pty、libsql 都要下预编译产物 |
| `npm install` 报 404 找不到 `@ash/shared` | **不是网络问题**。`@ash/*` 是本仓库的 workspace,公共 registry 上没有;npm 拿着这个名字去公网找,只说明它没把 `shared/` 认成本地 workspace ——多半是包没解全、或者不是在仓库根跑的。`node scripts/workspace-check.mjs` 会指出具体缺哪个、目录里还剩什么,并按「git 检出 / 解包目录」给出对应的恢复命令(`npm run setup` 在下载前已自动查这一遍) |
| `npm start` 报 `Cannot find module .../server/dist/index.js` | 还没构建过。`npm run build`;要是连 `node_modules` 都没有,说明装机没走完,回去跑 `npm run setup` 并解决它报的那个错——别绕过它直接 `npm start` |
| 「在本机打开文件」点了没反应 | `ASH_LOCAL_OPEN_ROOTS` 没设成他自己的路径 |
| Windows 上建 worktree 报 `Filename too long` | 撞了 MAX_PATH(260)。两个开关缺一不可:管理员 PowerShell 里 `Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1`,再 `git config --global core.longpaths true`(Git for Windows 走自带 msys 运行时,**不看**系统开关)。`npm run setup` 会替你查这两条 |

---

## 六、给别人之前想清楚的两件事

1. **别把 `data/` 一起发出去**——里面有 API key 和你全部的任务记录。用 `npm run package` 就不会犯这个错;手动 `tar czf` 打整个目录就会。
2. **它默认监听所有网卡(0.0.0.0)且没有任何鉴权**:谁能连到这个端口,谁就能派任务、读代码、在那台机器上跑命令。只在信任的网络里用(或前面挡一层反代 + 认证)。这是自托管单人工具的既定取舍,不是配置疏漏——但对方得知道。跨机器**接力**是唯一的例外:它有自己的机器身份校验(一机一对 ed25519 密钥、双向指纹核对、逐请求签名),陌生机器推不进任务,详见 `docs/handoff.md`。
