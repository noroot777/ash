# 把 harness 装到别人的机器上

两件事:**你这边打包**、**他那边执行**。

---

## 一、你这边:打包

```bash
npm run package                 # 产物落 dist-package/harness-<日期>-<sha>.tar.gz
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

> 想连历史一起给、又没有共享 remote:`git bundle create harness.bundle --all`,对方 `git clone harness.bundle harness`。

---

## 二、他那边:执行

### 0. 前置(必须先有)

| 依赖 | 要求 | 说明 |
|---|---|---|
| **macOS / Linux / Windows** | — | 三个平台都能原生跑,Windows 不需要 WSL2(脚本全是 `.mjs`,系统调用按平台分了实现) |
| **Node.js** | >= 20,建议 22+ | `node -v` |
| **git** | 任意近版 | worktree 隔离、审查 diff、验收合并全靠它 |
| **至少一个 agent CLI** | 已安装**并登录过** | 见下 |

harness 是**调度台**,自己不写代码——它拉起 `claude` / `codex` 这类 CLI 去干活。所以对方机器上必须有至少一个,并且**已经登录过一次**(harness 用的是这些 CLI 自己的登录态,不需要在 harness 里填 API key):

```bash
npm install -g @anthropic-ai/claude-code   &&  claude    # 登录一次
npm install -g @openai/codex               &&  codex     # 登录一次
```

界面「设置 → 执行器」里有完整目录(gemini / cursor / opencode / qwen / copilot …)和各自的官方安装命令。

### 1. 解包并一键安装

```bash
tar xzf harness-<日期>-<sha>.tar.gz
cd harness-<日期>-<sha>
node scripts/setup.mjs
```

> 拿到的是 `.zip` 就换成资源管理器右键「全部解压缩」,或 PowerShell 里 `Expand-Archive harness-<日期>-<sha>.zip .`;后面两条命令一样。

这一条命令做了 5 件事:检查环境 → `npm install` → `npm run build` → **接上 harness MCP** → 列出可派活的 CLI。幂等,重复跑不会重复写配置。

可选开关:`PORT=4317`(换端口)、`SKIP_MCP=1`(不动 CLI 配置)、`SKIP_BUILD=1`。

### 2. 起服务

```bash
npm start            # 前台跑,Ctrl-C 停
# 或
npm run restart      # 构建 + 后台常驻,日志 /tmp/harness-4317.log(Windows 是 %TEMP%\harness-4317.log)
```

浏览器开 **http://localhost:4317** —— 同一个端口既是界面也是 API。

> Windows 上这几条命令在 PowerShell / cmd 里直接跑就行(`tar` 自 Windows 10 1803 起是系统自带的)。唯一要留意的是**换行符**:仓库里的 `.githooks/*` 是 shell 脚本,由 Git for Windows 自带的 bash 执行,`git config core.autocrlf` 设成 `input` 或 `false`,别让它们被转成 CRLF。

### 3. 第一次用

1. **新建项目**:填一个 git 仓库的**绝对路径**(harness 就在这个仓库里派活)
2. 新建任务 → 选执行器 → 跑

执行器列表为空也能跑:不选就用该 CLI 的默认配置。想固定模型/思考强度再去「设置 → 执行器」建 profile。

---

## 三、MCP 那一步为什么不能省

harness 里的 agent 是靠 **harness MCP 的 `complete_task`** 交卷的:回合结束时没有这个确认,任务一律按未完成记成 `failed`(exit 0 ≠ done)。MCP 没接上 = agent 压根没有那个工具可调 = **每个任务跑完都是红的**。

`setup.mjs` 已经自动接好了。手动接的话:

```bash
# claude(user 作用域,编排别的仓库时也在)
claude mcp add harness --scope user \
  -e HARNESS_URL=http://localhost:4317 \
  -- node /绝对路径/harness/mcp/dist/index.js

# codex:追加到 ~/.codex/config.toml
[mcp_servers.harness]
command = "node"
args = ["/绝对路径/harness/mcp/dist/index.js"]

[mcp_servers.harness.env]
HARNESS_URL = "http://localhost:4317"
```

路径必须是**绝对路径**,而且指向解包后的那份 `mcp/dist/index.js`(所以要先 build)。改了端口,这里的 `HARNESS_URL` 要一起改。

验证:`claude mcp list` 应该看到 `harness: … ✔ Connected`。

---

## 四、日常运维

**升级**:`git pull`(或换个新 tar 包解到旁边)后 `npm install && npm run restart`。库会在启动时自动补列迁移,不需要单独跑迁移命令。

**数据与备份**:全在仓库里的 `data/`——`harness.db`(SQLite)+ `runs/`(每轮的正文、trace、验证证据)+ `uploads/`。备份就备份这个目录;换机器把它整个拷过去即可。`data/` 不入库,所以你发出去的包永远不含对方不该看的东西,反过来对方的数据也不会被你的包覆盖。

**环境变量**:

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | `4317` | 服务端口 |
| `HARNESS_DB` | `<仓库>/data/harness.db` | 库文件位置 |
| `HARNESS_LOCAL_OPEN_ROOTS` | 作者机器上的两个路径 | 「在本机打开文件」允许的根目录,冒号分隔。**换机器基本都要重设**,否则这个功能不可用 |

**常驻**:`npm run restart` 用 detached spawn 起进程,关掉终端也活着。想要开机自启就自己包一层 launchd(macOS)/ systemd(Linux)/ 计划任务(Windows,触发器选「登录时」),`ExecStart` 写 `node <仓库>/server/dist/index.js`,`WorkingDirectory` 写仓库根。

**只能起一个**:同一个库上有单例锁,第二个实例会拒绝启动并告诉你谁占着。想再起一个隔离实例:`PORT=4318 HARNESS_DB=/tmp/x.db npm start`。

---

## 五、排错

| 症状 | 多半是 |
|---|---|
| 任务跑完全是 `failed`,日志里没报错 | MCP 没接上(见第三节),agent 无法调 `complete_task` |
| 起不来,说端口被占 | 已经有一个实例在跑:`lsof -nP -iTCP:4317 -sTCP:LISTEN`(Windows:`Get-NetTCPConnection -LocalPort 4317 -State Listen`) |
| 界面打得开但一片空白/样式旧 | `web-next/dist` 没构建或过期:`npm run build`(server 从磁盘读 dist,**不用重启**) |
| 派任务立刻 ENOENT | 那个 CLI 没装,或不在 server 进程的 PATH 里(从 GUI 启动的进程 PATH 常常更短——用终端起服务) |
| `npm install` 卡住/失败 | 网络或 registry;node-pty、libsql 都要下预编译产物 |
| 「在本机打开文件」点了没反应 | `HARNESS_LOCAL_OPEN_ROOTS` 没设成他自己的路径 |
| Windows 上建 worktree 报 `Filename too long` | 撞了 MAX_PATH(260)。两个开关缺一不可:管理员 PowerShell 里 `Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1`,再 `git config --global core.longpaths true`(Git for Windows 走自带 msys 运行时,**不看**系统开关)。`npm run setup` 会替你查这两条 |

---

## 六、给别人之前想清楚的两件事

1. **别把 `data/` 一起发出去**——里面有 API key 和你全部的任务记录。用 `npm run package` 就不会犯这个错;手动 `tar czf` 打整个目录就会。
2. **它默认监听所有网卡(0.0.0.0)且没有任何鉴权**:谁能连到这个端口,谁就能派任务、读代码、在那台机器上跑命令。只在信任的网络里用(或前面挡一层反代 + 认证)。这是自托管单人工具的既定取舍,不是配置疏漏——但对方得知道。
