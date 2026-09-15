/* Git 工作台 demo · 分支视图：本地 / 任务 / 远程三组，图上能做的分支操作这里都有入口。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  const TASK_STATE = { running: "任务进行中", accepted: "已验收", failed: "任务失败" };

  function lastCommitOf(sha) { return S.commitMap().get(sha); }

  /* ---------- 新建分支 ---------- */
  function createDialog(atSha) {
    const body = el("div", "confirm-body");
    body.append(el("p", "confirm-text", "起点：" + (atSha ? "提交 " + atSha : "当前 HEAD（" + (S.state.head.branch || S.state.head.sha) + "）")));
    const input = el("input", "ui-input");
    input.placeholder = "分支名，如 feature/git-workbench-ui";
    body.append(input);
    const lab = el("label", "amend-toggle");
    const cb = el("input"); cb.type = "checkbox"; cb.checked = true;
    lab.append(cb, "创建后切换过去");
    body.append(lab);
    const cancel = btn("ui-btn", "取消", () => m.close());
    const okBtn = btn("ui-btn primary", "创建", () => {
      const name = input.value.trim();
      if (!name) return;
      m.close();
      GW.report(ops.createBranch(name, atSha || null, cb.checked));
    });
    const m = GW.modal({ title: "新建分支", body, actions: [cancel, okBtn] });
    input.focus();
  }

  function renameDialog(b) {
    const body = el("div", "confirm-body");
    const input = el("input", "ui-input");
    input.value = b.name;
    body.append(el("p", "confirm-text", "重命名分支 " + b.name), input);
    const cancel = btn("ui-btn", "取消", () => m.close());
    const okBtn = btn("ui-btn primary", "重命名", () => {
      const name = input.value.trim();
      if (!name || name === b.name) { m.close(); return; }
      m.close();
      GW.report(ops.renameBranch(b.name, name));
    });
    const m = GW.modal({ title: "重命名分支", body, actions: [cancel, okBtn] });
    input.focus(); input.select();
  }

  async function deleteFlow(b) {
    const main = S.branchOf("main");
    const merged = main && S.reachable(main.sha).has(b.sha);
    const okGo = await GW.confirmDialog(merged
      ? { title: "删除分支？", body: b.name + " 已合并进 main，删除是安全的。", confirmText: "删除" }
      : {
        title: "删除未合并的分支？", tone: "grave",
        warn: "它有 main 上没有的提交" + (b.task ? "，并且关联任务「" + b.task.title + "」" : ""),
        body: "删除 " + b.name + " 会让这些提交离开所有分支（快照与 reflog 仍可找回）。",
        typed: b.name, confirmText: "删除分支",
      });
    if (okGo) GW.report(ops.deleteBranch(b.name));
  }

  function branchMenu(anchor, b, isCurrent) {
    const cur = S.state.head.branch;
    GW.menu(anchor, [
      { label: "切换到此分支", icon: "check", disabled: isCurrent, onClick: () => GW.report(ops.checkout(b.name)) },
      { label: "合并到 " + (cur || "当前"), icon: "merge", disabled: isCurrent || !cur, onClick: () => GW.report(ops.merge(b.name)) },
      { label: "把 " + (cur || "当前") + " 变基到此之上", icon: "history", disabled: isCurrent || !cur, onClick: () => GW.report(ops.rebaseOnto(b.name)) },
      { sep: true },
      { label: "重命名…", icon: "tag", onClick: () => renameDialog(b) },
      { label: "复制分支名", icon: "copy", onClick: () => { navigator.clipboard && navigator.clipboard.writeText(b.name); GW.toast("已复制 " + b.name, "ok"); } },
      { sep: true },
      { label: "删除分支…", icon: "trash", tone: "danger", disabled: isCurrent, onClick: () => deleteFlow(b) },
    ]);
  }

  function branchRow(b) {
    const isCurrent = !S.state.head.sha && S.state.head.branch === b.name;
    const row = el("div", "branch-row ui-selectable" + (isCurrent ? " is-selected" : ""));
    const name = el("span", "branch-name");
    name.innerHTML = GW.icon("branch", 14) + "<b>" + b.name + "</b>" + (isCurrent ? '<em class="cur-tag">当前</em>' : "");
    row.append(name);
    if (b.task) {
      row.append(el("span", "task-chip state-" + b.task.state,
        [b.task.title, el("i", null, TASK_STATE[b.task.state] || b.task.state)]));
    }
    if (b.upstream) {
      const ab = S.aheadBehind(b.sha, S.remoteOf(b.upstream).sha);
      const chip = el("span", "sync-chip");
      chip.innerHTML = (ab.ahead ? '<i class="up">' + GW.icon("up", 11) + ab.ahead + "</i>" : "")
        + (ab.behind ? '<i class="dn">' + GW.icon("down", 11) + ab.behind + "</i>" : "")
        + (!ab.ahead && !ab.behind ? '<i class="ok">已同步</i>' : "");
      row.append(chip);
    } else {
      const mainB = S.branchOf("main");
      if (mainB && b.name !== "main") {
        const ab = S.aheadBehind(b.sha, mainB.sha);
        row.append(el("span", "sync-chip vs-main", "较 main +" + ab.ahead + " / −" + ab.behind));
      }
    }
    const last = lastCommitOf(b.sha);
    if (last) row.append(el("span", "branch-last", last.msg), el("span", "branch-time", GW.timeAgo(last.time)));
    const acts = el("span", "file-actions");
    if (!isCurrent) {
      const sw = btn("icon-btn", null, () => GW.report(ops.checkout(b.name)));
      sw.innerHTML = GW.icon("check", 13);
      sw.setAttribute("aria-label", "切换");
      acts.append(sw);
    }
    const dots = btn("icon-btn", null, () => branchMenu(dots, b, isCurrent));
    dots.innerHTML = GW.icon("dots", 14);
    acts.append(dots);
    row.append(acts);
    return row;
  }

  function remoteRow(rb) {
    const row = el("div", "branch-row ui-selectable is-remote");
    const name = el("span", "branch-name");
    name.innerHTML = GW.icon("sync", 13) + "<b>" + rb.name + "</b>";
    row.append(name);
    const last = lastCommitOf(rb.sha);
    if (last) row.append(el("span", "branch-last", last.msg), el("span", "branch-time", GW.timeAgo(last.time)));
    const acts = el("span", "file-actions");
    const dots = btn("icon-btn", null, () => GW.menu(dots, [
      { label: "检出为本地跟踪分支", icon: "branch", disabled: !!S.branchOf(rb.name.replace(/^origin\//, "")),
        onClick: () => GW.report(ops.checkoutRemote(rb.name)) },
      { label: "删除远程分支…", icon: "trash", tone: "danger", onClick: async () => {
        const okGo = await GW.confirmDialog({
          title: "删除远程分支？", tone: "danger",
          warn: "这会改动远端仓库，别的协作者会受影响", body: rb.name, confirmText: "删除远程分支", safety: false,
        });
        if (okGo) GW.report(S.op(
          { cmd: "git push origin --delete " + rb.name.replace(/^origin\//, ""), summary: "删除远程分支 " + rb.name, undoable: false },
          () => { S.state.remoteBranches = S.state.remoteBranches.filter((x) => x !== rb); return "已删除远程分支 " + rb.name; }
        ));
      } },
    ]));
    dots.innerHTML = GW.icon("dots", 14);
    acts.append(dots);
    row.append(acts);
    return row;
  }

  function section(title, hint, rows, extra) {
    const sec = el("section", "branch-group");
    const head = el("header", "group-head");
    head.append(el("b", null, title), el("span", "group-count", String(rows.length)), el("i", "group-hint", hint || ""));
    if (extra) head.append(el("span", "group-actions", extra));
    sec.append(head);
    rows.forEach((r) => sec.append(r));
    if (!rows.length) sec.append(el("p", "empty-line", "（无）"));
    return sec;
  }

  GW.views = GW.views || {};
  GW.views.branches = {
    title: "分支", icon: "branch",
    createDialog,
    render(container) {
      const wrap = el("div", "branches-view scroll-col");
      wrap.dataset.scrollKey = "branches";
      const locals = S.state.branches.filter((b) => !b.name.startsWith("ash/"));
      const taskBranches = S.state.branches.filter((b) => b.name.startsWith("ash/"));

      const newBtn = btn("mini-btn tone-accent", null, () => createDialog(null));
      newBtn.innerHTML = GW.icon("plus", 12) + "<span>新建分支</span>";

      wrap.append(section("本地分支", "", locals.map(branchRow), newBtn));
      wrap.append(section("任务分支", "由 ash 任务创建，验收合并后可清理", taskBranches.map(branchRow)));
      wrap.append(section("远程分支", "origin 上的引用，" + GW.timeAgo(S.state.lastFetch) + "拉取过", S.state.remoteBranches.map(remoteRow)));
      container.append(wrap);
    },
  };
})();
