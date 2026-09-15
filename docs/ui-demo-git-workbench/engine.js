/* Git 工作台 demo · mock git 引擎（核心）。
   真实实现里这些操作对应 server 端点 + withRepoLock；demo 在内存里模拟同样的语义：
   每个操作 = 快照（可撤销）→ 变更状态 → 记入操作日志 → 通知重渲染。 */
window.GW = window.GW || {};

(function () {
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const state = {
    repo: clone(GW.seed.repo),
    head: clone(GW.seed.head),
    branches: clone(GW.seed.branches),
    remoteBranches: clone(GW.seed.remoteBranches),
    commits: clone(GW.seed.commits),
    workingFiles: clone(GW.seed.workingFiles),
    operation: null,           // 进行中的 merge / rebase / cherry-pick / revert
    stashes: clone(GW.seed.stashes),
    tags: clone(GW.seed.tags),
    worktrees: clone(GW.seed.worktrees),
    oplog: clone(GW.seed.oplog),
    lock: { holder: null, queue: [] },
    remotePendingUsed: false,
    lastFetch: Date.now() - 3 * 3600 * 1000,
  };

  const listeners = [];
  function emit() { listeners.forEach((fn) => fn()); }

  /* ---------- 基础设施 ---------- */
  let opSeq = 100;
  function snapshot() {
    const { oplog, ...rest } = state;
    return clone(rest);
  }
  function restore(snap) {
    Object.keys(snap).forEach((k) => { state[k] = clone(snap[k]); });
  }

  /** 统一操作入口：锁被占时排队（对应后端 withRepoLock），否则立即执行。
      fn 返回一句给 toast 的话；抛错则记一条失败日志。 */
  function op(meta, fn) {
    if (state.lock.holder) {
      return new Promise((resolve) => {
        state.lock.queue.push({ label: meta.summary, run: () => resolve(exec(meta, fn)) });
        emit();
      });
    }
    return Promise.resolve(exec(meta, fn));
  }
  function exec(meta, fn) {
    const entry = {
      id: ++opSeq, time: Date.now(), actor: meta.actor || "user",
      cmd: meta.cmd, summary: meta.summary, result: "ok",
      undoable: meta.undoable !== false,
    };
    const snap = entry.undoable ? snapshot() : null;
    try {
      const msg = fn();
      if (snap) entry.snap = snap;
      state.oplog.push(entry);
      emit();
      return { ok: true, message: msg || meta.summary };
    } catch (err) {
      entry.result = "fail";
      entry.summary = meta.summary + " — " + err.message;
      entry.undoable = false;
      state.oplog.push(entry);
      emit();
      return { ok: false, message: err.message };
    }
  }

  /* ---------- 提交图查询 ---------- */
  const commitMap = () => {
    const m = new Map();
    state.commits.forEach((c) => m.set(c.sha, c));
    return m;
  };
  function reachable(sha) {
    const m = commitMap(), seen = new Set(), stack = [sha];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      const c = m.get(cur);
      if (c) stack.push(...c.parents);
    }
    return seen;
  }
  function aheadBehind(a, b) {
    const ra = reachable(a), rb = reachable(b);
    let ahead = 0, behind = 0;
    ra.forEach((s) => { if (!rb.has(s)) ahead++; });
    rb.forEach((s) => { if (!ra.has(s)) behind++; });
    return { ahead, behind };
  }
  function branchOf(name) { return state.branches.find((b) => b.name === name); }
  function remoteOf(name) { return state.remoteBranches.find((b) => b.name === name); }
  function headSha() {
    if (state.head.sha) return state.head.sha;
    const b = branchOf(state.head.branch);
    return b ? b.sha : null;
  }
  function headBranch() { return state.head.branch ? branchOf(state.head.branch) : null; }
  function randSha() {
    let s = "";
    while (s.length < 7) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  function addCommit(msg, parents, files, author) {
    const c = { sha: randSha(), parents, msg, author: author || "fjh", time: Date.now(), files: files || [] };
    state.commits.push(c);
    return c;
  }
  /** 当前分支相对 base 的独有提交，旧 → 新（交互式变基 / pull --rebase 用）。 */
  function ownCommits(tip, base) {
    const keep = reachable(tip), drop = reachable(base);
    return state.commits
      .filter((c) => keep.has(c.sha) && !drop.has(c.sha))
      .sort((a, b) => a.time - b.time);
  }

  /* ---------- 工作区聚合（渲染用） ---------- */
  function fileGroups() {
    const groups = { staged: [], unstaged: [], untracked: [] };
    state.workingFiles.forEach((f) => {
      const by = { staged: [], unstaged: [], untracked: [] };
      f.hunks.forEach((h, i) => by[h.loc].push({ ...h, index: i }));
      ["staged", "unstaged", "untracked"].forEach((loc) => {
        if (by[loc].length) {
          groups[loc].push({
            path: f.path, kind: loc === "staged" && f.kind === "U" ? "A" : f.kind,
            hunks: by[loc],
            add: by[loc].reduce((n, h) => n + h.lines.filter((l) => l.t === "add").length, 0),
            del: by[loc].reduce((n, h) => n + h.lines.filter((l) => l.t === "del").length, 0),
          });
        }
      });
    });
    return groups;
  }
  function stagedSummary() {
    return fileGroups().staged.map((f) => ({ path: f.path, kind: f.kind, add: f.add, del: f.del }));
  }

  /* ---------- 工作区操作 ---------- */
  function findFile(path) { return state.workingFiles.find((f) => f.path === path); }
  function dropEmpty(file) {
    if (!file.hunks.length) state.workingFiles = state.workingFiles.filter((f) => f !== file);
  }
  const ops = {};

  ops.stageFile = (path) => op(
    { cmd: "git add -- " + path, summary: "暂存 " + path },
    () => { findFile(path).hunks.forEach((h) => { h.loc = "staged"; }); return "已暂存 " + path; }
  );
  ops.unstageFile = (path) => op(
    { cmd: "git restore --staged -- " + path, summary: "取消暂存 " + path },
    () => {
      const f = findFile(path);
      f.hunks.forEach((h) => { h.loc = f.kind === "U" ? "untracked" : "unstaged"; });
      return "已取消暂存 " + path;
    }
  );
  ops.stageHunk = (path, index) => op(
    { cmd: "git add -p -- " + path, summary: "暂存 " + path + " 的一个改动块" },
    () => { findFile(path).hunks[index].loc = "staged"; return "已暂存该改动块"; }
  );
  ops.unstageHunk = (path, index) => op(
    { cmd: "git restore --staged -p -- " + path, summary: "取消暂存 " + path + " 的一个改动块" },
    () => {
      const f = findFile(path);
      f.hunks[index].loc = f.kind === "U" ? "untracked" : "unstaged";
      return "已取消暂存该改动块";
    }
  );
  ops.discardFile = (path) => op(
    { cmd: "git restore -- " + path, summary: "丢弃 " + path + " 的未暂存改动" },
    () => {
      const f = findFile(path);
      f.hunks = f.hunks.filter((h) => h.loc === "staged");
      dropEmpty(f);
      return "已丢弃改动（快照可撤销）";
    }
  );
  ops.discardHunk = (path, index) => op(
    { cmd: "git restore -p -- " + path, summary: "丢弃 " + path + " 的一个改动块" },
    () => {
      const f = findFile(path);
      f.hunks.splice(index, 1);
      dropEmpty(f);
      return "已丢弃该改动块（快照可撤销）";
    }
  );
  /** 行级暂存：把选中的改动行拆出去成暂存块，其余留在工作树。 */
  ops.stageLines = (path, index, lineIdx) => op(
    { cmd: "git add -p（行级）-- " + path, summary: "暂存 " + path + " 的所选 " + lineIdx.length + " 行" },
    () => {
      const f = findFile(path);
      const h = f.hunks[index];
      const pick = new Set(lineIdx);
      const stagedLines = h.lines.filter((l, i) => l.t === "ctx" || pick.has(i));
      const restLines = h.lines.filter((l, i) => l.t === "ctx" || !pick.has(i));
      const hasChange = (ls) => ls.some((l) => l.t !== "ctx");
      f.hunks.splice(index, 1);
      if (hasChange(stagedLines)) f.hunks.push({ header: h.header, lines: stagedLines, loc: "staged" });
      if (hasChange(restLines)) f.hunks.push({ header: h.header, lines: restLines, loc: h.loc });
      return "已暂存所选行";
    }
  );
  ops.stageAll = () => op(
    { cmd: "git add -A", summary: "暂存全部改动" },
    () => { state.workingFiles.forEach((f) => f.hunks.forEach((h) => { h.loc = "staged"; })); return "已暂存全部改动"; }
  );
  ops.unstageAll = () => op(
    { cmd: "git reset", summary: "取消全部暂存" },
    () => {
      state.workingFiles.forEach((f) => f.hunks.forEach((h) => {
        if (h.loc === "staged") h.loc = f.kind === "U" ? "untracked" : "unstaged";
      }));
      return "已取消全部暂存";
    }
  );

  /* ---------- 提交 ---------- */
  ops.commit = (message, opts = {}) => op(
    { cmd: "git commit" + (opts.amend ? " --amend" : "") + " -m \"" + message.split("\n")[0] + "\"",
      summary: (opts.amend ? "修补提交：" : "提交：") + message.split("\n")[0] },
    () => {
      const b = headBranch();
      if (!b) throw new Error("HEAD 处于游离状态，先切回或新建分支再提交");
      const files = stagedSummary();
      if (!files.length && !opts.amend) throw new Error("暂存区是空的");
      state.workingFiles.forEach((f) => { f.hunks = f.hunks.filter((h) => h.loc !== "staged"); });
      state.workingFiles = state.workingFiles.filter((f) => f.hunks.length);
      if (opts.amend) {
        const old = commitMap().get(b.sha);
        const c = addCommit(message || old.msg, old.parents, old.files.concat(files), old.author);
        b.sha = c.sha;
        return "已修补最近一次提交 → " + c.sha;
      }
      const c = addCommit(message, [b.sha], files);
      b.sha = c.sha;
      return "已提交 " + c.sha + "：" + message.split("\n")[0];
    }
  );

  /* ---------- 分支 ---------- */
  ops.checkout = (name) => op(
    { cmd: "git switch " + name, summary: "切换到分支 " + name, undoable: false },
    () => {
      if (!branchOf(name)) throw new Error("分支不存在：" + name);
      if (state.operation) throw new Error("有进行中的" + state.operation.typeLabel + "，先完成或中止");
      state.head = { branch: name };
      return "已切换到 " + name + (state.workingFiles.length ? "（未提交改动随行）" : "");
    }
  );
  ops.checkoutRemote = (remoteName) => op(
    { cmd: "git switch -c " + remoteName.replace(/^origin\//, "") + " --track " + remoteName,
      summary: "检出远程分支 " + remoteName },
    () => {
      const r = remoteOf(remoteName);
      const local = remoteName.replace(/^origin\//, "");
      if (branchOf(local)) throw new Error("本地已有同名分支 " + local);
      state.branches.push({ name: local, sha: r.sha, upstream: remoteName });
      state.head = { branch: local };
      return "已检出 " + local + "（跟踪 " + remoteName + "）";
    }
  );
  ops.checkoutSha = (sha) => op(
    { cmd: "git checkout " + sha, summary: "游离检出 " + sha, undoable: false },
    () => { state.head = { sha }; return "HEAD 已游离在 " + sha + "，提交前记得建分支"; }
  );
  ops.createBranch = (name, at, checkout) => op(
    { cmd: "git branch " + name + (at ? " " + at : ""), summary: "新建分支 " + name },
    () => {
      if (branchOf(name)) throw new Error("分支已存在：" + name);
      state.branches.push({ name, sha: at || headSha(), upstream: null });
      if (checkout) state.head = { branch: name };
      return "已创建分支 " + name + (checkout ? " 并切换" : "");
    }
  );
  ops.renameBranch = (oldName, newName) => op(
    { cmd: "git branch -m " + oldName + " " + newName, summary: "重命名分支 " + oldName + " → " + newName },
    () => {
      if (branchOf(newName)) throw new Error("分支已存在：" + newName);
      branchOf(oldName).name = newName;
      if (state.head.branch === oldName) state.head.branch = newName;
      return "已重命名为 " + newName;
    }
  );
  ops.deleteBranch = (name) => op(
    { cmd: "git branch -D " + name, summary: "删除分支 " + name },
    () => {
      if (state.head.branch === name) throw new Error("不能删除当前所在分支");
      state.branches = state.branches.filter((b) => b.name !== name);
      return "已删除分支 " + name + "（快照可撤销）";
    }
  );
  ops.setUpstream = (name, upstream) => op(
    { cmd: "git branch -u " + upstream + " " + name, summary: name + " 设置上游 " + upstream, undoable: false },
    () => { branchOf(name).upstream = upstream; return "已设置上游 " + upstream; }
  );

  /* ---------- 合并与冲突 ---------- */
  ops.merge = (name) => op(
    { cmd: "git merge " + name, summary: "合并 " + name + " 到 " + state.head.branch },
    () => {
      const b = headBranch();
      if (!b) throw new Error("游离 HEAD 上不能合并");
      const src = branchOf(name);
      if (reachable(b.sha).has(src.sha)) return name + " 已包含在当前分支，无事可做";
      if (reachable(src.sha).has(b.sha)) { b.sha = src.sha; return "已快进到 " + src.sha; }
      if (name === GW.seed.conflictScript.branch) {
        state.operation = {
          type: "merge", typeLabel: "合并", source: name, target: b.name,
          files: clone(GW.seed.conflictScript.files).map((f) => ({
            ...f, blocks: f.blocks.map((blk) => ({ ...blk, choice: null, custom: null })),
          })),
        };
        return "合并遇到冲突：" + state.operation.files.length + " 个文件待解决";
      }
      const c = addCommit("Merge branch '" + name + "'", [b.sha, src.sha], []);
      b.sha = c.sha;
      return "已合并 " + name + " → " + c.sha;
    }
  );
  ops.resolveBlock = (fileIdx, blockIdx, choice, custom) => {
    const f = state.operation.files[fileIdx];
    f.blocks[blockIdx].choice = choice;
    f.blocks[blockIdx].custom = custom || null;
    emit();
  };
  ops.abortOperation = () => op(
    { cmd: "git " + state.operation.type + " --abort", summary: "中止" + state.operation.typeLabel, undoable: false },
    () => { const label = state.operation.typeLabel; state.operation = null; return "已中止" + label + "，工作区恢复原状"; }
  );
  ops.continueMerge = () => op(
    { cmd: "git merge --continue", summary: "完成合并 " + (state.operation && state.operation.source) },
    () => {
      const opn = state.operation;
      const unresolved = opn.files.reduce((n, f) => n + f.blocks.filter((b) => !b.choice).length, 0);
      if (unresolved) throw new Error("还有 " + unresolved + " 个冲突块未解决");
      const b = headBranch();
      const src = branchOf(opn.source);
      const files = opn.files.map((f) => ({ path: f.path, kind: "M", add: 6, del: 2 }));
      const c = addCommit("Merge branch '" + opn.source + "'", [b.sha, src.sha], files);
      b.sha = c.sha;
      state.operation = null;
      return "冲突已解决，合并完成 → " + c.sha;
    }
  );

  /* ---------- 变基 / 拣选 / 回滚 / 重置 ---------- */
  ops.rebaseOnto = (ontoName) => op(
    { cmd: "git rebase " + ontoName, summary: "把 " + state.head.branch + " 变基到 " + ontoName },
    () => {
      const b = headBranch();
      const onto = branchOf(ontoName) || remoteOf(ontoName);
      if (reachable(onto.sha).has(b.sha)) { b.sha = onto.sha; return "已快进到 " + onto.sha; }
      const own = ownCommits(b.sha, onto.sha);
      let parent = onto.sha;
      own.forEach((c) => { const nc = addCommit(c.msg, [parent], c.files, c.author); parent = nc.sha; });
      b.sha = parent;
      return "已重放 " + own.length + " 个提交到 " + ontoName + " 之上";
    }
  );
  /** 交互式变基的候选序列（旧 → 新）。UI 拿去生成 plan。 */
  ops.rebasePlanFor = (baseSha) => ownCommits(headSha(), baseSha)
    .map((c) => ({ sha: c.sha, msg: c.msg, action: "pick", newMsg: null }));
  ops.applyRebase = (baseSha, plan) => op(
    { cmd: "git rebase -i " + baseSha, summary: "交互式变基（" + plan.length + " 个提交）" },
    () => {
      const b = headBranch();
      const m = commitMap();
      let parent = baseSha, last = null, count = 0;
      plan.forEach((item) => {
        const c = m.get(item.sha);
        if (item.action === "drop") return;
        if ((item.action === "squash" || item.action === "fixup") && last) {
          if (item.action === "squash") last.msg = last.msg + " + " + c.msg;
          last.files = last.files.concat(c.files);
          return;
        }
        const nc = addCommit(item.action === "reword" && item.newMsg ? item.newMsg : c.msg, [parent], clone(c.files), c.author);
        parent = nc.sha; last = nc; count++;
      });
      b.sha = last ? last.sha : baseSha;
      return "变基完成：" + plan.length + " 个提交重写为 " + count + " 个";
    }
  );
  ops.cherryPick = (sha) => op(
    { cmd: "git cherry-pick " + sha, summary: "拣选 " + sha + " 到 " + state.head.branch },
    () => {
      const b = headBranch();
      const src = commitMap().get(sha);
      const c = addCommit(src.msg, [b.sha], clone(src.files), src.author);
      b.sha = c.sha;
      return "已拣选 " + sha + " → " + c.sha;
    }
  );
  ops.revert = (sha) => op(
    { cmd: "git revert " + sha, summary: "回滚提交 " + sha },
    () => {
      const b = headBranch();
      const src = commitMap().get(sha);
      const c = addCommit("Revert \"" + src.msg + "\"", [b.sha],
        clone(src.files).map((f) => ({ ...f, add: f.del, del: f.add })));
      b.sha = c.sha;
      return "已生成回滚提交 " + c.sha;
    }
  );
  ops.resetTo = (sha, mode) => op(
    { cmd: "git reset --" + mode + " " + sha, summary: "重置 " + state.head.branch + " 到 " + sha + "（" + mode + "）" },
    () => {
      const b = headBranch();
      b.sha = sha;
      if (mode === "mixed" || mode === "hard") {
        state.workingFiles.forEach((f) => f.hunks.forEach((h) => {
          if (h.loc === "staged") h.loc = f.kind === "U" ? "untracked" : "unstaged";
        }));
      }
      if (mode === "hard") {
        state.workingFiles = state.workingFiles.filter((f) => f.kind === "U");
      }
      return "已重置到 " + sha + "（demo 已自动留快照，可在操作日志撤销）";
    }
  );

  GW.store = {
    state, ops, emit,
    subscribe: (fn) => listeners.push(fn),
    fileGroups, aheadBehind, reachable, branchOf, remoteOf, headSha, headBranch,
    commitMap, addCommit, ownCommits, clone, op, randSha,
  };
})();
