# AGENTS.md

这个文件是**所有执行器**（claude / codex / …）都要遵守的约定。只留一种东西：**claude 和 codex 都必须遵守、且系统当前做不进去**的规则。其余全部有别的去处：

| 去处 | 装什么 | 谁读得到 |
|---|---|---|
| `server/CLAUDE.md` | 改 server 代码时要知道的实现说明 | claude（懒加载：接触 `server/` 文件后才注入） |
| `web-next/CLAUDE.md` | 改前端代码时要知道的说明 | claude（同上） |
| `mobile/AGENTS.md` | mobile 约定 | claude / codex |
| `docs/incidents.md` | 事故经过、踩坑记录、被证伪的路 | 想查「为什么非得这样」时自己翻 |
| 代码注释 / 类型 / 检查脚本 / 回归测试 | 能做进系统的全部 | 所有执行器，无条件 |

`CLAUDE.md` 是本文件的一行别名，两边不会漂移。

## 加规则要先经用户同意（用户 2026-08-07 拍板）

**未经用户明确同意，不得新增任何规则。** 覆盖本文件、任何目录级 `CLAUDE.md`/`AGENTS.md`、`docs/incidents.md`，以及以规则形式写下的代码注释。判据是**这段字有没有在约束下一个 agent 的行为**——「这块代码为什么这么写」是说明，不受限；「以后一律必须 X」是规则，要先问。

确有必要就在回复里**提出来问用户，得到同意再落盘**；没同意就只当本轮的临时判断，写进回复正文，不写进文件。删除、搬走、合并已有规则不受此限——那是减法，随时可做。

**这条有硬闸**（`.githooks/commit-msg` → `scripts/rule-guard.mjs`）：任何 `CLAUDE.md`/`AGENTS.md` 与 `docs/incidents.md` **净增字节**的提交一律拒绝，除非 commit message 里带 `[规则已获用户同意]`；授权放行也会把新增内容打在终端上。改写/压缩/删除不需要口令。

## 元规则：新约定先找地方放，根文件是最后一档

拿到用户同意之后（见上一节），按这个顺序往下问，能停在哪一档就停在哪一档：

1. 让它**编译不过**（类型 / API 形状）
2. 让**检查脚本**拦住（`scripts/check-conventions.mjs`，挂在前端 build 前置）
3. 用**回归测试**钉住（`server/scripts/test-*.ts`）
4. 写成**就近的代码注释**（改这块代码的人一定会看到）
5. 写进**目录级** `CLAUDE.md`
6. 都不行，才写根文件

判据按**受众**读而不是按**题材**读——问的是「哪种执行器可能领到需要这条的任务」，不是「这条讲的是谁家的事」。事故经过一律进 `docs/incidents.md`，根文件只留规则本体加一个指针。

**体积有硬闸**：`.githooks/pre-commit` 棘轮式拦下「把根文件改大且超 8192 字节」的提交（只拦增长、不拦存量）。**新克隆后需执行一次 `git config core.hooksPath .githooks`**。

闸同时负责**对称计账**：每次提交都报出净变化和当前水位（增也报、减也报），被拒时列出当前最占地方的几节。

## 重构授权

随时留意需求是否已经变动到「现有代码结构不再合适」的程度。一旦判断需求变动足够大、值得重构，就大胆重构，不要为了迁就旧结构而打补丁。

## Git 仓库改动立即提交

只要当前工作目录位于 Git 仓库，执行器对文件所作的所有改动在完成并验证后立即提交，不等待用户另行要求；提交只包含本轮负责的改动，不夹带用户或其他执行器已有的未提交内容。（用户 2026-08-18 指定）

## 派活:操作电脑的活给 codex

浏览器/CDP/GUI 自动化这类「操作电脑」任务,一律派 codex(codex@cpa·gpt-5.6-sol)执行,不派 claude(用户 2026-07-30 指定)。

## 任务完成协议

**exit 0 ≠ done**，规则本体由 prompt 前言注入（fresh run）/ 消息尾部提醒（reply/resume 回合），此处不复述——**别再往任何 md 里加第四份拷贝**。改结算逻辑看 `server/CLAUDE.md`。

## 停止/暂停必须留下持久可见的状态

只弹一个 toast 不算数。判据：**用户刷新页面后仍能看出「我停过」**。反面案例（后端全做对了、用户却只能得出「按钮坏了」，而且它掩盖了真问题）见 `docs/incidents.md`「停止全组」。

## 旁路会话：harness 杀不到的东西

**三层击杀只覆盖 harness 自己 spawn 的进程树**，`killChild` 之外还有一类杀不到的：**旁路会话**——agent 通过 IPC 请求一个独立常驻应用代跑的活。实例：codex 的 computer use 由 `/Applications/ChatGPT.app` 侧拉起 `SkyComputerUseService`（**开机级全局单例**），harness 的进程组/fd/ppid 三条线索一条都够不着它。

处理规矩：

1. **已知有效的唯一手段是杀掉 agent 进程本身**（CUA 服务有 `shouldTerminateWhenNoClientsRemain` 语义，客户端一死它就自行退出）
2. **`SkyComputerUseClient turn-ended` 这条路已被实测证伪，别再试**
3. **兜底绝不自动杀 CUA 服务**——检测到残留只如实上报（`GET /tasks/:id/team/cua-status`），强杀走用户主动点的显式端点（`POST /tasks/:id/team/kill-cua`）并明示副作用

理由：那是 harness 管辖范围之外的全局单例，杀它会外溢到用户在 ChatGPT 里的其它会话；这类不可逆又外溢的操作，默认必须是「告诉用户 + 给一个他自己按的开关」。另注意 `pauseGroup` 只处理 `running`/`queued` 成员，**已 `done` 执行者遗留的旁路会话是清理盲区**，所以 `haltTeam` 的扇出必须遍历全部执行者 session 而不限状态。（证伪实验的四种 payload、仍未验证的「正常完成会不会残留」，见 `docs/incidents.md`「CUA 旁路会话」）
