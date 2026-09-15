/* Git 工作台 demo · mock git 引擎（扩展）：同步、贮藏、标签、工作树、演示剧本、AI、撤销。 */
(function () {
  const S = GW.store, state = S.state, ops = S.ops, clone = S.clone;

  function restore(snap) {
    Object.keys(snap).forEach((k) => { state[k] = clone(snap[k]); });
  }

  /* ---------- 撤销：恢复操作前的整仓快照 ----------
     真实实现对应「每个危险操作前自动建 backup ref + reflog 指引」；demo 直接回放快照。 */
  ops.undo = (entryId) => {
    const entry = state.oplog.find((e) => e.id === entryId);
    if (!entry || !entry.snap) return { ok: false, message: "这条操作没有快照可回退" };
    const label = entry.summary;
    restore(entry.snap);
    delete entry.snap;
    entry.undoable = false;
    state.oplog.push({
      id: entry.id + 10000, time: Date.now(), actor: "user",
      cmd: "（快照回退）", summary: "撤销：" + label, result: "ok", undoable: false,
    });
    S.emit();
    return { ok: true, message: "已撤销：" + label };
  };

  /* ---------- 远程同步 ---------- */
  ops.fetch = () => S.op(
    { cmd: "git fetch origin", summary: "拉取远端引用", undoable: false },
    () => {
      state.lastFetch = Date.now();
      if (!state.remotePendingUsed) return "已拉取，远端没有新提交";
      const om = S.remoteOf("origin/main");
      const pending = GW.seed.remotePending.filter((c) => !S.commitMap().has(c.sha));
      if (!pending.length) return "已拉取，远端没有新提交";
      pending.forEach((c) => state.commits.push(clone(c)));
      om.sha = GW.seed.remotePending[GW.seed.remotePending.length - 1].sha;
      return "已拉取：origin/main 新增 " + pending.length + " 个提交";
    }
  );
  ops.pull = (rebase) => S.op(
    { cmd: "git pull" + (rebase ? " --rebase" : ""), summary: "拉取并" + (rebase ? "变基" : "合并") },
    () => {
      const b = S.headBranch();
      if (!b || !b.upstream) throw new Error("当前分支没有上游");
      const up = S.remoteOf(b.upstream);
      const ab = S.aheadBehind(b.sha, up.sha);
      if (!ab.behind) return "已是最新，无需拉取";
      if (!ab.ahead) { b.sha = up.sha; return "已快进 " + ab.behind + " 个提交"; }
      if (rebase) {
        const own = S.ownCommits(b.sha, up.sha);
        let parent = up.sha;
        own.forEach((c) => { const nc = S.addCommit(c.msg, [parent], clone(c.files), c.author); parent = nc.sha; });
        b.sha = parent;
        return "已把本地 " + own.length + " 个提交变基到远端之上";
      }
      const c = S.addCommit("Merge remote-tracking branch '" + b.upstream + "'", [b.sha, up.sha], []);
      b.sha = c.sha;
      return "已合并远端（生成合并提交 " + c.sha + "）";
    }
  );
  ops.push = (force) => S.op(
    { cmd: "git push" + (force ? " --force-with-lease" : ""), summary: "推送 " + (state.head.branch || "HEAD"), undoable: false },
    () => {
      const b = S.headBranch();
      if (!b) throw new Error("游离 HEAD 不能直接推送");
      if (!b.upstream) {
        const remoteName = "origin/" + b.name;
        state.remoteBranches.push({ name: remoteName, sha: b.sha });
        b.upstream = remoteName;
        return "已发布分支到 " + remoteName;
      }
      const up = S.remoteOf(b.upstream);
      const ab = S.aheadBehind(b.sha, up.sha);
      if (ab.behind && !force) throw new Error("远端有你没有的提交，先拉取（或确认后带保护强推）");
      if (!ab.ahead && !ab.behind) return "已是最新，无需推送";
      up.sha = b.sha;
      return (force ? "已带保护强推（--force-with-lease）" : "已推送 " + ab.ahead + " 个提交") + "到 " + b.upstream;
    }
  );

  /* ---------- 贮藏 ----------
     对应 AGENTS.md 的规矩：共享 stash 栈必须带标签、apply 不 pop 别人的。demo 自动打上会话标签。 */
  let stashSeq = 10;
  ops.stashPush = (msg, includeUntracked) => S.op(
    { cmd: "git stash push -u -m \"" + msg + "\"", summary: "贮藏当前改动" },
    () => {
      const files = [];
      state.workingFiles = state.workingFiles.filter((f) => {
        if (f.kind === "U" && !includeUntracked) return true;
        files.push({ path: f.path, kind: f.kind, hunks: clone(f.hunks),
          add: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === "add").length, 0),
          del: f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.t === "del").length, 0) });
        return false;
      });
      if (!files.length) throw new Error("没有可贮藏的改动");
      state.stashes.unshift({ id: ++stashSeq, msg: "wip(ash:本会话): " + msg, branch: state.head.branch || "HEAD",
        time: Date.now(), session: "本会话", files });
      return "已贮藏 " + files.length + " 个文件（自动带会话标签）";
    }
  );
  function stashBack(st) {
    st.files.forEach((f) => {
      const existing = state.workingFiles.find((w) => w.path === f.path);
      const hunks = (f.hunks || []).map((h) => ({ ...h, loc: f.kind === "U" ? "untracked" : "unstaged" }));
      if (existing) existing.hunks = existing.hunks.concat(hunks);
      else state.workingFiles.push({ path: f.path, kind: f.kind, hunks });
    });
  }
  ops.stashApply = (id) => S.op(
    { cmd: "git stash apply", summary: "应用贮藏（保留原条目）" },
    () => { stashBack(state.stashes.find((s) => s.id === id)); return "已应用贮藏，条目保留在栈上"; }
  );
  ops.stashPop = (id) => S.op(
    { cmd: "git stash pop", summary: "应用并移除贮藏" },
    () => {
      const st = state.stashes.find((s) => s.id === id);
      if (st.session !== "本会话") throw new Error("这是别的会话贮藏的，规矩是 apply 不 pop（防止弄丢别人的现场）");
      stashBack(st);
      state.stashes = state.stashes.filter((s) => s.id !== id);
      return "已应用并移除该贮藏";
    }
  );
  ops.stashDrop = (id) => S.op(
    { cmd: "git stash drop", summary: "删除贮藏条目" },
    () => { state.stashes = state.stashes.filter((s) => s.id !== id); return "已删除该贮藏（快照可撤销）"; }
  );

  /* ---------- 标签 ---------- */
  ops.tagCreate = (name, sha, annotated, msg) => S.op(
    { cmd: annotated ? "git tag -a " + name + " -m \"" + (msg || "") + "\"" : "git tag " + name,
      summary: "在 " + sha + " 打标签 " + name },
    () => {
      if (state.tags.some((t) => t.name === name)) throw new Error("标签已存在：" + name);
      state.tags.unshift({ name, sha, annotated, msg: msg || "", pushed: false });
      return "已创建标签 " + name;
    }
  );
  ops.tagDelete = (name) => S.op(
    { cmd: "git tag -d " + name, summary: "删除标签 " + name },
    () => { state.tags = state.tags.filter((t) => t.name !== name); return "已删除标签 " + name + "（仅本地）"; }
  );
  ops.tagPush = (name) => S.op(
    { cmd: "git push origin " + name, summary: "推送标签 " + name, undoable: false },
    () => { state.tags.find((t) => t.name === name).pushed = true; return "已推送标签 " + name; }
  );

  /* ---------- 工作树（ash 任务隔离目录） ---------- */
  ops.worktreeMerge = (path) => S.op(
    { cmd: "git merge --no-ff <worktree-branch>", summary: "把工作树分支合并回 main" },
    () => {
      const wt = state.worktrees.find((w) => w.path === path);
      const main = S.branchOf("main");
      const src = S.branchOf(wt.branch);
      if (S.reachable(main.sha).has(src.sha)) return wt.branch + " 已在 main 里，无需合并";
      const c = S.addCommit("Merge branch '" + wt.branch + "'", [main.sha, src.sha], []);
      main.sha = c.sha;
      if (wt.task) wt.task.state = "accepted";
      wt.dirty = false;
      return "已合并 " + wt.branch + " → main（" + c.sha + "）";
    }
  );
  ops.worktreeRemove = (path) => S.op(
    { cmd: "git worktree remove " + path, summary: "删除工作树 " + path },
    () => {
      state.worktrees = state.worktrees.filter((w) => w.path !== path);
      return "已删除工作树（分支保留，快照可撤销）";
    }
  );
  ops.worktreePrune = () => S.op(
    { cmd: "git worktree prune + 清理已验收目录", summary: "清理已验收的工作树" },
    () => {
      const before = state.worktrees.length;
      state.worktrees = state.worktrees.filter((w) => w.isMain || w.dirty || !(w.task && w.task.state === "accepted"));
      const n = before - state.worktrees.length;
      if (!n) return "没有可清理的工作树";
      return "已清理 " + n + " 个已验收且干净的工作树";
    }
  );

  /* ---------- 演示剧本 ---------- */
  ops.scriptRemote = () => {
    if (state.remotePendingUsed) return { ok: false, message: "剧本已触发过" };
    state.remotePendingUsed = true;
    S.emit();
    return { ok: true, message: "剧本就绪：远端出现了新提交，点「拉取」看看" };
  };
  ops.scriptAgentLock = () => {
    if (state.lock.holder) return { ok: false, message: "锁已被占用" };
    state.lock.holder = { actor: "agent", reason: "验收合并 ash/pFq2LmXc", since: Date.now() };
    S.emit();
    setTimeout(() => {
      state.lock.holder = null;
      const queued = state.lock.queue.splice(0);
      state.oplog.push({ id: Date.now() % 100000, time: Date.now(), actor: "agent",
        cmd: "git merge --no-ff ash/pFq2LmXc（模拟）", summary: "agent 验收合并完成，释放仓库锁", result: "ok", undoable: false });
      S.emit();
      queued.forEach((q) => q.run());
    }, 6000);
    return { ok: true, message: "剧本就绪：agent 占用了仓库锁 6 秒，期间你的操作会排队" };
  };

  /* ---------- AI 辅助 ----------
     真实实现：调用当前项目配置的 LLM；demo 按暂存内容拼一条像样的消息。 */
  ops.genCommitMessage = () => new Promise((resolve) => {
    const staged = S.fileGroups().staged;
    setTimeout(() => {
      if (!staged.length) { resolve(""); return; }
      const areas = [...new Set(staged.map((f) => f.path.split("/")[0]))];
      const scope = areas.length === 1 ? areas[0] : "scm";
      resolve("feat(" + scope + "): 工作台入口与提交锁接入\n\n- ScmInspector 顶部可跳转项目级 Git 工作台\n- 提交动作统一排进 withRepoLock 队列");
    }, 700);
  });
  ops.aiConflictHint = (fileIdx, blockIdx) => {
    const blk = state.operation.files[fileIdx].blocks[blockIdx];
    return blk.ai || blk.ours.concat(blk.theirs);
  };
})();
