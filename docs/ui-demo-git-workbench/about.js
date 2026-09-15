/* Git 工作台 demo · 设计说明：这份设计想解决什么、怎么落到 ash 后端。 */
(function () {
  const HTML = `
<section>
  <h3>这份设计要解决什么</h3>
  <p>ash 现在的 git 能力散在几处：任务面板的 SCM 区能 stage / commit / push，验收页能合并，
  但分支、历史、贮藏、标签、工作树、冲突、变基这些一旦要碰，就得离开页面开终端。
  这份「Git 工作台」把它们收进<b>一个项目级视图</b>：左边七个入口（变更 / 历史 / 分支 / 贮藏 / 标签 / 工作树 / 操作日志），
  顶部一条常驻的分支与同步状态，进行中的合并冲突用横幅压在所有视图上方——目标是绝大部分日常 git 操作不再需要终端。</p>

  <h3>五条设计原则</h3>
  <ol>
    <li><b>危险分级，而不是一律弹窗。</b>安全操作（stage、切分支、fetch）一步到位；
    有影响的操作（丢弃、删除已合并分支）红色确认；不可逆操作（hard reset、删未合并分支、删他人现场）要抄一遍目标名。
    确认框永远先把<b>安全网</b>亮出来（自动快照 / reflog），把用户从「不敢点」变成「敢点」。</li>
    <li><b>一切操作留痕、多数可撤销。</b>每个页面动作在「操作日志」里落一条：谁（用户 / agent / 验收流程）、
    等价命令、结果。危险操作执行前自动建快照（真实实现是 backup ref + reflog 锚点），日志里一键撤销。</li>
    <li><b>仓库锁可视化。</b>页面操作与 agent 的验收合并走同一条 withRepoLock 队列。锁被占时不报错、不静默，
    横幅明说「谁在用、你的操作排在后面」，释放后自动依次执行。</li>
    <li><b>与任务系统贯通。</b>ash/* 分支挂任务徽章（哪个任务、什么状态），工作树卡片能直接「合并回 main」（即验收动作）、
    清理已验收目录；分支永不自动删。</li>
    <li><b>AI 在场但不抢方向盘。</b>提交信息生成、冲突块的建议合并、
    「整份冲突交给 agent」——AI 产出的每一步都要用户点头才落地。</li>
  </ol>

  <h3>操作覆盖清单</h3>
  <p><b>变更</b>：文件 / 改动块 / 行 三档 stage、unstage、discard；未跟踪与删除文件；提交（含 amend、AI 生成信息）。<br>
  <b>历史</b>：提交图（多分支泳道）、搜索、提交详情 diff；图上直接 checkout（游离）、建分支、打标签、
  cherry-pick、revert、reset（soft / mixed / hard）、交互式变基（reorder / reword / squash / fixup / drop）。<br>
  <b>分支</b>：切换、新建、重命名、删除（按是否已合并分级）、合并入当前、变基当前、检出远程、删除远程。<br>
  <b>同步</b>：fetch / pull（merge 或 rebase）/ push（发布、被拒引导、--force-with-lease 强推）。<br>
  <b>贮藏</b>：push（自动带会话标签）、apply / pop / drop、内容查看；跨会话共享栈的规矩做进交互（别人的只能 apply）。<br>
  <b>标签</b>：轻量 / 附注、创建、删除、单独推送。<br>
  <b>工作树</b>：任务关联、脏状态、合并回 main、删除、批量清理已验收。<br>
  <b>冲突</b>：全屏解决器，逐块 我方 / 对方 / 都要 / AI 建议 / 手工编辑，continue / abort。</p>

  <h3>落地到 ash 的对接草案</h3>
  <p>入口：项目页新增「Git」标签，任务面板 SCM 区标题跳转过来（demo 里未暂存区那份 diff 演的就是这一步）。</p>
  <p>后端沿用现有底座，新增薄读写层：</p>
  <ul>
    <li><code>GET /api/projects/:id/git/workbench</code> —— 一次带全：status、branches（含 ahead/behind 与任务关联）、
    stashes、tags、worktrees、operation 状态。轮询节奏沿用 SCM 面板的 5s / 页面不可见即停。</li>
    <li>写操作按域拆路由：<code>POST …/git/branches</code>、<code>…/git/merge</code>、<code>…/git/rebase</code>、
    <code>…/git/stash</code>、<code>…/git/tags</code>、<code>…/git/reset</code>、<code>…/git/sync</code>（fetch/pull/push）。
    全部包在 <code>withRepoLock</code> 里，锁状态与排队队列暴露成
    <code>GET …/git/lock</code>，供横幅轮询。</li>
    <li>冲突解决：<code>GET …/git/conflicts</code> 返回逐文件逐块的 ours/theirs/base；
    <code>POST …/git/conflicts/resolve</code> 按块写回（后端落盘该文件的合并结果），
    <code>POST …/git/continue|abort</code> 收尾。AI 建议复用现有 LLM 直连通道；「交给 agent」= 派生一个带冲突上下文的任务。</li>
    <li>撤销：危险写操作前自动 <code>git branch refs/ash-backup/&lt;ts&gt;</code>（或 stash 快照），
    操作日志表记录 backup ref；撤销端点按记录反做。操作日志复用现有 oplog 思路入库，和任务时间线同源展示。</li>
    <li>复用清单：<code>git-exec</code> / <code>repo-lock</code> / <code>git-status</code> / <code>git-diff</code> /
    <code>git-accept*</code>（工作树「合并回 main」直接走验收链路）/ <code>git-worktree-*</code>。</li>
  </ul>

  <h3>demo 怎么玩</h3>
  <p>右上「演示剧本」：① 让远端长出新提交 → 体验 fetch / pull --rebase / push 被拒与保护强推；
  ② 让 agent 占仓库锁 6 秒 → 期间随便点操作，看排队与自动续跑。
  在「分支」里合并 <code>feature/conflict-demo</code> 可进入完整的冲突解决流程；
  「历史」里任意提交的 ⋯ 菜单能发起 reset / revert / cherry-pick / 交互式变基。所有状态都在内存里，刷新即复位。</p>
</section>`;

  GW.overlays = GW.overlays || {};
  GW.overlays.about = {
    open() {
      const body = GW.html("div", "about-body", HTML);
      GW.modal({ title: "Git 工作台 · 设计说明", body, wide: true });
    },
  };
})();
