/* Git 工作台 demo · 变更视图：暂存区语义完整呈现 —— 文件级 / 块级 / 行级三档操作 + 提交。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  let selected = null;          // { group, path }
  let commitMsg = "";
  let amend = false;

  const GROUP_META = {
    conflict: { label: "合并冲突", hint: "先解决冲突才能继续" },
    staged: { label: "已暂存", hint: "将进入下一次提交" },
    unstaged: { label: "未暂存", hint: "工作树里的改动" },
    untracked: { label: "未跟踪", hint: "新文件" },
  };

  function pickDefault(groups) {
    if (selected) {
      const g = groups[selected.group];
      if (g && g.some((f) => f.path === selected.path)) return;
    }
    const order = ["unstaged", "staged", "untracked"];
    for (const key of order) {
      if (groups[key] && groups[key].length) { selected = { group: key, path: groups[key][0].path }; return; }
    }
    selected = null;
  }

  /* ---------- 文件行 ---------- */
  function fileRow(group, f) {
    const row = btn("file-row ui-selectable" + (selected && selected.group === group && selected.path === f.path ? " is-selected" : ""), null,
      () => { selected = { group, path: f.path }; GW.app.render(); });
    row.append(GW.kindBadge(f.kind));
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    const name = f.path.slice(dir.length);
    row.append(el("span", "file-name", [name, dir ? el("i", "file-dir", dir) : null]));
    row.append(GW.statLabel(f.add, f.del));
    const actions = el("span", "file-actions");
    fileActions(group, f).forEach((a) => {
      const b = btn("icon-btn" + (a.tone ? " tone-" + a.tone : ""), null, a.onClick);
      b.innerHTML = GW.icon(a.icon, 13);
      b.setAttribute("aria-label", a.label);
      actions.append(b);
    });
    row.append(actions);
    return row;
  }

  function fileActions(group, f) {
    if (group === "conflict") return [];
    if (group === "staged") {
      return [{ icon: "undo", label: "取消暂存", onClick: () => GW.report(ops.unstageFile(f.path)) }];
    }
    const acts = [{ icon: "plus", label: "暂存", onClick: () => GW.report(ops.stageFile(f.path)) }];
    acts.push({
      icon: "trash", label: group === "untracked" ? "删除文件" : "丢弃改动", tone: "danger",
      onClick: async () => {
        const okGo = await GW.confirmDialog({
          title: group === "untracked" ? "删除未跟踪文件？" : "丢弃改动？",
          tone: "danger",
          warn: group === "untracked" ? "文件将被删除，Git 里没有它的任何记录" : "工作树里的这些改动将被还原",
          body: f.path,
          confirmText: group === "untracked" ? "删除" : "丢弃",
        });
        if (okGo) GW.report(ops.discardFile(f.path));
      },
    });
    return acts;
  }

  /* ---------- 分组 ---------- */
  function groupSection(key, files, headActions) {
    const meta = GROUP_META[key];
    const sec = el("section", "change-group group-" + key);
    const head = el("header", "group-head");
    head.append(el("b", null, meta.label), el("span", "group-count", String(files.length)), el("i", "group-hint", meta.hint));
    const acts = el("span", "group-actions");
    (headActions || []).forEach((a) => {
      const b = btn("mini-btn", null, a.onClick);
      b.innerHTML = (a.icon ? GW.icon(a.icon, 12) : "") + "<span>" + a.label + "</span>";
      acts.append(b);
    });
    head.append(acts);
    sec.append(head);
    files.forEach((f) => sec.append(fileRow(key, f)));
    return sec;
  }

  /* ---------- 提交区 ---------- */
  function commitBox(groups) {
    const box = el("div", "commit-box");
    const ta = el("textarea", "commit-input");
    ta.placeholder = "提交信息（第一行是标题）";
    ta.value = commitMsg;
    ta.rows = 3;
    ta.addEventListener("input", () => { commitMsg = ta.value; syncBtn(); });
    box.append(ta);

    const row = el("div", "commit-row");
    const aiBtn = btn("mini-btn tone-accent", null, async () => {
      aiBtn.disabled = true;
      aiBtn.innerHTML = GW.icon("ai", 12) + "<span>生成中…</span>";
      const msg = await ops.genCommitMessage();
      aiBtn.disabled = false;
      aiBtn.innerHTML = GW.icon("ai", 12) + "<span>AI 生成</span>";
      if (!msg) { GW.toast("暂存区是空的，先暂存再生成", "err"); return; }
      commitMsg = msg; ta.value = msg; syncBtn();
    });
    aiBtn.innerHTML = GW.icon("ai", 12) + "<span>AI 生成</span>";
    row.append(aiBtn);

    const amendLabel = el("label", "amend-toggle");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = amend;
    cb.addEventListener("change", () => {
      amend = cb.checked;
      if (amend && !commitMsg.trim()) {
        const tip = S.commitMap().get(S.headSha());
        if (tip) { commitMsg = tip.msg; ta.value = tip.msg; }
      }
      syncBtn();
    });
    amendLabel.append(cb, "修补上一次提交");
    row.append(amendLabel, el("span", "flex-1"));

    const commitBtn = btn("ui-btn primary", null, async () => {
      const r = await ops.commit(commitMsg.trim(), { amend });
      GW.report(r);
      if (r.ok) { commitMsg = ""; amend = false; GW.app.render(); }
    });
    row.append(commitBtn);
    box.append(row);

    function syncBtn() {
      const n = groups.staged.length;
      commitBtn.textContent = amend ? "修补提交" : "提交" + (n ? "（" + n + " 个文件）" : "");
      commitBtn.disabled = !commitMsg.trim() || (!n && !amend);
    }
    syncBtn();
    return box;
  }

  /* ---------- 右侧 diff ---------- */
  function diffPane(groups) {
    const pane = el("div", "diff-pane");
    if (!selected) {
      pane.append(GW.html("div", "empty-hint", GW.icon("changes", 28) + "<p>工作区干净，没有待处理的改动</p>"));
      return pane;
    }
    const list = groups[selected.group] || [];
    const f = list.find((x) => x.path === selected.path);
    if (!f) { pane.append(el("div", "empty-hint", "该文件已不在这一组")); return pane; }

    const head = el("header", "diff-pane-head");
    head.append(GW.kindBadge(f.kind), el("code", "diff-path", f.path), GW.statLabel(f.add, f.del), el("span", "flex-1"));
    fileActions(selected.group, f).forEach((a) => {
      const b = btn("mini-btn" + (a.tone ? " tone-" + a.tone : ""), null, a.onClick);
      b.innerHTML = GW.icon(a.icon, 12) + "<span>" + a.label + "</span>";
      head.append(b);
    });
    pane.append(head);

    const isStaged = selected.group === "staged";
    const body = el("div", "diff-scroll");
    body.dataset.scrollKey = "changes-diff";
    body.append(GW.renderDiff(f.hunks, {
      hunkActions: (h) => {
        if (selected.group === "untracked") return [];
        if (isStaged) {
          return [{ label: "取消暂存此块", icon: "undo", onClick: () => GW.report(ops.unstageHunk(f.path, h.index)) }];
        }
        return [
          { label: "暂存此块", icon: "plus", onClick: () => GW.report(ops.stageHunk(f.path, h.index)) },
          { label: "丢弃此块", icon: "trash", tone: "danger", onClick: async () => {
            const okGo = await GW.confirmDialog({
              title: "丢弃这个改动块？", tone: "danger",
              warn: "这一块的改动将被还原", body: f.path, confirmText: "丢弃",
            });
            if (okGo) GW.report(ops.discardHunk(f.path, h.index));
          } },
        ];
      },
      lineStage: (!isStaged && selected.group !== "untracked")
        ? (h, lineIdx) => GW.report(ops.stageLines(f.path, h.index, lineIdx))
        : null,
    }));
    if (!isStaged && selected.group !== "untracked") {
      body.append(GW.html("p", "diff-tip", GW.icon("ai", 12) + "<span>点选具体改动行可只暂存那几行 —— 同一文件里顺手改的两件事，就该拆成两次提交。</span>"));
    }
    pane.append(body);
    return pane;
  }

  /* ---------- 冲突组 ---------- */
  function conflictSection() {
    const opn = S.state.operation;
    if (!opn) return null;
    const sec = el("section", "change-group group-conflict");
    const head = el("header", "group-head");
    head.append(el("b", null, GROUP_META.conflict.label), el("span", "group-count", String(opn.files.length)));
    const open = btn("mini-btn tone-danger", null, () => GW.overlays.conflict.open());
    open.innerHTML = GW.icon("merge", 12) + "<span>打开冲突解决器</span>";
    head.append(el("span", "group-actions", open));
    sec.append(head);
    opn.files.forEach((f) => {
      const solved = f.blocks.every((b) => b.choice);
      const row = btn("file-row", null, () => GW.overlays.conflict.open(f.path));
      row.append(GW.kindBadge("!"), el("span", "file-name", f.path),
        el("span", "conflict-state" + (solved ? " is-done" : ""), solved ? "已解决" : f.blocks.filter((b) => !b.choice).length + " 块待解决"));
      sec.append(row);
    });
    return sec;
  }

  GW.views = GW.views || {};
  GW.views.changes = {
    title: "变更", icon: "changes",
    badge() {
      const g = S.fileGroups();
      const n = g.staged.length + g.unstaged.length + g.untracked.length + (S.state.operation ? S.state.operation.files.length : 0);
      return n || null;
    },
    render(container) {
      const groups = S.fileGroups();
      pickDefault(groups);
      const wrap = el("div", "changes-view");
      const left = el("div", "changes-list");
      left.dataset.scrollKey = "changes-list";

      const conflict = conflictSection();
      if (conflict) left.append(conflict);

      left.append(groupSection("staged", groups.staged, [
        { label: "全部取消暂存", icon: "undo", onClick: () => GW.report(ops.unstageAll()) },
      ]));
      left.append(groupSection("unstaged", groups.unstaged, [
        { label: "全部暂存", icon: "plus", onClick: () => GW.report(ops.stageAll()) },
        { label: "贮藏…", icon: "stash", onClick: () => GW.views.stash.pushDialog() },
      ]));
      left.append(groupSection("untracked", groups.untracked, []));
      left.append(el("div", "flex-1"));
      left.append(commitBox(groups));
      wrap.append(left, diffPane(groups));
      container.append(wrap);
    },
  };
})();
