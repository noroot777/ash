# 让智能体已装的 skill 在对话框 / 新建任务里直接 `/` 调用

> 任务书。结论与数据均已实测（2026-08-05，claude 2.1.220 / codex-cli 0.144.0），**下一个执行者不必重跑探针**。
> 落点行号基于 `feat/issue-center` 分支的 68b863a。

## 1. 目标

用户在 harness 的**对话框**和**新建任务**里敲 `/`，能补全并调用「当前这一轮要派给的那个 CLI 自己已安装的技能」，选中后照常发送。附带在设置页给一个**技能清单刷新间隔**的设置项。

价值判断：技能是 Claude Code / Codex 自带的能力，harness **一行提示词工程都不用写**，只要把入口露出来。

## 2. 已验证的事实（不要重复验证）

### 2.1 headless 下 `/技能名` 直接可用 —— 无需任何 CLI 专用参数

| 探针 | 命令 | 结果 |
|---|---|---|
| claude | `claude -p "/harness-probe" --output-format stream-json --verbose --dangerously-skip-permissions`（即 harness 现用参数） | ✅ 技能被执行 |
| codex | `codex exec "/harness-probe" --skip-git-repo-check -s read-only` | ✅ 命中 |

两者机制不同：claude 是 CLI 自己认这个 slash；**codex 是模型看着技能索引自己去 `sed` 读 SKILL.md**，效果一样但不是硬保证。

推论：**执行侧一行代码都不用改**，`/名字` 原样留在 prompt 里发下去即可。

### 2.2 claude 的 `system/init` 事件白送权威清单

每次 claude 跑起来吐的第一行 JSON 里带 `skills` 和 `slash_commands` 两个全量数组，含**插件技能**和 `/review` `/simplify` 这类**根本不在磁盘上的内置技能**。`server/src/executors/claude.ts` 的 `parseClaudeStream` 现在把这个字段直接丢了。

⚠️ **绝不能为了拿清单主动跑一次 CLI**：探针那次 haiku 就花了 $0.084（66k tokens 的 cache creation）。它只能搭便车。

### 2.3 成本实测 —— 全量扫描便宜到不需要"增量获取"

| 动作 | 耗时 | 能发现什么 |
|---|---|---|
| 全量扫盘（读 78 个 SKILL.md 的 frontmatter） | 冷 5.1 ms / 热 2.9 ms | 全部 |
| **stat 指纹**（78 次 stat，取 mtime+size） | **0.21 ms** | 增、删、改内容 |
| 只 stat 三个根目录 | 0.006 ms | 只有增删，**改内容抓不到** |
| 传给前端的 JSON | 5.7 KB | — |

### 2.4 mtime 传播语义（实测）

```
改 SKILL.md 内容后 → 根目录 mtime 变了吗: 否   ← 关键
新增一个技能目录后 → 根目录 mtime 变了吗: 是
```

所以指纹**必须逐个 stat `SKILL.md`**。只看根目录的话，用户改了某个技能的 description，菜单永远显示旧文案且**永远不会自己好**。差价 0.2 ms，别省。

### 2.5 本机现状：跨 CLI 大量软链共享

| 目录 | 条目 | 其中软链 |
|---|---|---|
| `~/.claude/skills` | 31 | 15 |
| `~/.codex/skills` | 35 | 12 |
| `~/.gemini/skills` | 12 | 12 |

78 个条目 **去重（realpath）后只有 54 个物理技能**，典型形态：

```
~/.codex/skills/hyperframes -> ../../.claude/skills/hyperframes
```

claude ∩ codex 的同名交集是 15 个。本机只装了 claude 和 codex 两个 CLI（gemini/cursor/qwen/kimi 均未安装），覆盖这两家 = 覆盖 100% 实际用量。

## 3. 设计：三层取数

**取数永远是全量**（3 ms 不值得做 diff 协议）。分层的是"什么时候重扫"和"缓存靠什么判活"。

### 第一层：全量扫盘 —— 唯一的取数方式

触发点仅三个：server 启动预热一次 / `/api/skills` 请求且指纹对不上 / 用户在设置页手点"重新扫描"（逃生口，再周密的失效判定也有漏网）。

扫描源按 agentType 分：

| agentType | 源 |
|---|---|
| claude | `<cwd>/.claude/skills/*`、`~/.claude/skills/*`、插件（见坑 3） |
| codex | `$CODEX_HOME/skills/*`（默认 `~/.codex/skills`）+ 项目级 |
| gemini | `~/.gemini/skills/*` |
| 其它 | 空表（degrade，不报错） |

### 第二层：stat 指纹 —— 增量的是"判断"，不是"数据"

每次请求先花 0.21 ms 打指纹（每个 `SKILL.md` 的 `mtime+size` 拼串）：一样直接返缓存；不一样**整份重扫**，不做"只重读变了的那几个"。省下的是 3 ms 里的一部分，换来的是一套"哪些变了 / 删的怎么清 / 软链指向变了算不算变"的状态机——不划算。

### 第三层：init 事件校准 —— 天然增量，搭便车

收到 claude 的 init → 用它覆盖该 `(agentType, cwd)` 的缓存条目并标记为"权威"。没跑过任务的项目就用扫盘结果，degrade 而不是空白。这是拿到内置技能和当前生效插件版本的**唯一渠道**。

### 触发点矩阵

| 场景 | 做什么 |
|---|---|
| server 启动 | 全量扫盘预热 |
| 用户敲 `/` | **什么都不做**，读内存缓存（不能按键触发 IO） |
| 打开对话框 / 新建任务面板 | 打指纹，变了才重扫 |
| 切换"派给谁"（agentType） | 只换过滤条件，不重扫 |
| 切换项目 / cwd 变了 | 重扫**项目级**那部分，用户级沿用 |
| 收到 claude init 事件 | 校准该 cwd 的条目 |
| 设置页手点刷新 | 清指纹，强制全量 |
| **定时轮询** | 按新增设置项的间隔（见 §4） |

## 4. 新增设置项：技能清单刷新间隔

用户明确要求"设置页加一个定时多久去获取的设置"。

- **字段**：`skillRefreshSeconds: number`
- **默认值**：`60`
- **取值**：`0` = 关闭定时刷新（只在打开面板/收到 init 时校验指纹）；其余取 `10 ~ 3600`
- **语义**：这是**前端轮询 `/api/skills` 的间隔**，不是服务端扫盘间隔——服务端永远靠指纹判活，轮询到了指纹没变就是 0.21 ms 的空转。文案要把这层说清楚，否则用户会以为调小了会拖慢机器。

落点（`satisfies` 会逼你四处对齐，漏一处编译不过）：

1. `shared/src/index.ts:23` `AppSettings` 接口加字段
2. `shared/src/index.ts:30` `DEFAULT_APP_SETTINGS` 加默认值
3. `server/src/app-settings.ts:9` `SETTING_SPECS` 加校验：`ok: (v) => typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= 10 && v <= 3600))`，hint 写"必须是 0（关闭）或 10~3600 的整数秒"
4. `web-next/src/settings/DefaultsSettings.tsx:67` 之后加一个 `settings-row`。**不要用原生 `<input type=number>` 裸奔**——沿用该页现有形状（`Toggle` / `WorkflowPicker` 那种），做成几档预设的下拉（关闭 / 30 秒 / 1 分钟 / 5 分钟 / 15 分钟）比自由输入更好，用户不需要"37 秒"这种精度

## 5. 实施清单

### 后端

1. **新建 `server/src/skills.ts`**（约 150 行，注意根 CLAUDE.md 的 700 行上限）
   - `listSkills({ agentType, cwd })` → `{ name, description, source: "user"|"project"|"plugin"|"builtin", command, realPath }[]`
   - frontmatter 解析：取文件前 2 KB 正则抠 `name:` / `description:` 就够，不必引 yaml 库
   - 指纹函数与缓存（模块级 Map，key = `agentType + cwd`）
2. **路由 `GET /api/skills?agentType=&projectId=`**，接在 `server/src/routes.ts` 现成的 `api.get` 风格里（参考 `routes.ts:214` 的 `/agents/catalog`）。返回体带上指纹串，前端可做 `If-None-Match` 式短路
3. **`server/src/executors/claude.ts` 的 `parseClaudeStream`**：`ev.type === "system" && ev.subtype === "init"` 时把 `ev.skills` / `ev.slash_commands` 交给 skills 模块校准。注意别影响现有 `session` 事件的 push

### 前端（四个表面，缺一个就露馅）

4. **`web-next/src/task-detail/ReplyBox.tsx:129`**：`command.items` 从静态两条变成"静态两条 + 动态技能表"。技能项要标成**透传**——不打开 inlinePanel，只把 `/名字 ` 补进正文照常发送。现有的候选过滤 / 上下键 / 回车选中逻辑（`ReplyBox.tsx:388-401`）直接复用
5. **`web-next/src/composer/TaskComposerPanel.tsx:197`**：`SLASHES` 同样加动态项。⚠️ 它的 `changeBody`（第 205 行）会把 `/single|team|debate ` **从正文里吃掉**，技能项必须走另一条分支保留在正文里
6. **`web-next/src/task-detail/TaskDerivationComposer.tsx`** 与团队 `dispatch` 的 body：同样支持，否则调度台派下去的活丢技能
7. **`mobile/src/app/task/[id].tsx`** 的输入框同步（mobile 改动靠 Metro，别重启 :4317）

## 6. 坑清单（真正花时间的地方）

1. **技能按 CLI 分家**。菜单必须跟着"这一轮派给谁"实时变。否则给 codex 敲一个只有 claude 有的技能，它会**静默当成一句普通话执行**，用户还以为技能生效了——这是本功能最容易翻车的地方。
2. **软链会被 `dirent.isDirectory()` 静默漏掉一半**。第一版扫描用 `readdirSync(withFileTypes)` + `isDirectory()`，78 个技能只扫出 39 个。必须用 `statSync`（它跟随软链）。
3. **插件技能目录堆着历史版本**：hyperframes 一家躺着 10 个版本目录（0.7.70 → 0.7.92）。glob 一扫会把废弃版本一起列出来，**必须读 `~/.claude/plugins/installed_plugins.json` 拿 installPath**。
4. **命名空间打架**：`/team` `/debate` `/single` 已被 harness 自己占用。建议 harness 自己的置顶 + 分隔线，技能在下面标来源；冲突时 harness 优先并给出提示。
5. **同一技能跨 CLI 共享**：78 条目去重后 54 个。菜单最好按 realpath 去重、标一个"claude/codex 都能用"的角标——否则用户切一次执行器看见列表变了一半，会以为技能丢了。
6. **codex 那条路不是硬保证**（§2.1）。建议做一个"强注入"开关：服务端在 `server/src/orchestrator.ts:236` 附近拼 prompt 时把 `/名字` 改写成「先读取并遵循 `<绝对路径>/SKILL.md` 再执行下面任务」。这条对任何能读文件的 CLI 都成立。同一处逻辑还需覆盖 `team/dispatch.ts` 和 reply/resume 路径。

## 7. 边界：现在不做

- 真正的增量拉取（只传变更）。越过下面任一条再说：技能数上千（现在 78，差一个数量级）／项目级技能随 worktree 漂移导致缓存 key 炸开。
- 在 harness 里编辑、安装、删除技能。这一版只读。

## 8. 验收标准

1. 对话框敲 `/` 能看到当前执行器的技能，选中后正文里留下 `/名字`，发送后该技能确实生效（拿一个有可观测输出的技能验，别只看菜单弹出来了）
2. 把执行器从 claude 切成 codex，菜单内容跟着变
3. 新建任务面板同上，且技能项**没有被 `changeBody` 吃掉**
4. 设置页能改刷新间隔，改完刷新页面仍然生效；设成 0 后不再轮询
5. 手动往 `~/.claude/skills/` 加一个技能目录，不重启 server，菜单能出现它
6. 改一个已有技能的 `description`，菜单里的副标题跟着变（验指纹逐文件 stat 这条）
7. `npm -w web-next run build` 与 server typecheck 通过
