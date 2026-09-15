/* Git 工作台 demo · 装配：顶栏（仓库 / 分支 / 同步）、进行中横幅、左导航、视图路由。 */
(function () {
  const S = GW.store, ops = S.ops, el = GW.el, btn = GW.btn;

  const VIEW_ORDER = ["changes", "history", "branches", "stash", "tags", "worktrees", "oplog"];

  /* ---------- 顶栏 ---------- */
  function branchPill() {
    const head = S.state.head;
    const pill = btn("branch-pill", null, () => {
      const items = S.state.branches.map((b) => ({
        label: b.name, icon: (!head.sha && head.branch === b.name) ? "check" : "branch",
        onClick: () => GW.report(ops.checkout(b.name)),
      }));
      items.push({ sep: true });
      items.push({ label: "新建分支…", icon: "plus", onClick: () => GW.views.branches.createDialog(null) });
      GW.menu(pill, items);
    });
    pill.innerHTML = (head.sha ? GW.icon("detach", 14) : GW.icon("branch", 14))
      + "<b>" + (head.sha ? "游离 @ " + head.sha : head.branch) + "</b>" + GW.icon("chevron", 12);
    return pill;
  }

  function syncGroup() {
    const wrap = el("div", "sync-group");
    const b = S.headBranch();
    const up = b && b.upstream ? S.remoteOf(b.upstream) : null;
    const ab = up ? S.aheadBehind(b.sha, up.sha) : null;

    const fetchBtn = btn("top-btn", null, async () => GW.report(await ops.fetch()));
    fetchBtn.innerHTML = GW.icon("sync", 14) + "<span>拉取引用</span>";
    fetchBtn.setAttribute("aria-label", "git fetch：只更新远端引用，不动本地分支");
    wrap.append(fetchBtn);

    const pullBtn = btn("top-btn" + (ab && ab.behind ? " has-badge" : ""), null, () => {
      GW.menu(pullBtn, [
        { label: "拉取并变基（推荐）", icon: "history", onClick: async () => GW.report(await ops.pull(true)) },
        { label: "拉取并合并", icon: "merge", onClick: async () => GW.report(await ops.pull(false)) },
      ]);
    });
    pullBtn.innerHTML = GW.icon("down", 14) + "<span>拉取</span>" + (ab && ab.behind ? '<em class="top-badge">' + ab.behind + "</em>" : "");
    wrap.append(pullBtn);

    const pushBtn = btn("top-btn" + (ab && ab.ahead ? " has-badge" : ""), null, async () => {
      const r = await ops.push(false);
      GW.report(r);
      if (!r.ok && /先拉取/.test(r.message)) {
        const force = await GW.confirmDialog({
          title: "推送被拒", tone: "danger",
          warn: "远端有本地没有的提交",
          body: "推荐先「拉取并变基」再推。确认要覆盖远端时才强推 —— 会用 --force-with-lease，远端在你上次拉取后又有新动静就会失败，不盲覆盖。",
          confirmText: "带保护强推", safety: false,
        });
        if (force) GW.report(await ops.push(true));
      }
    });
    pushBtn.innerHTML = GW.icon("up", 14) + "<span>推送</span>"
      + (ab && ab.ahead ? '<em class="top-badge">' + ab.ahead + "</em>" : "")
      + (b && !b.upstream ? '<em class="top-badge is-new">发布</em>' : "");
    wrap.append(pushBtn);
    return wrap;
  }

  function renderTopbar() {
    const bar = document.getElementById("topbar");
    bar.innerHTML = "";
    const left = el("div", "top-left");
    left.append(GW.html("span", "logo", GW.icon("branch", 16)));
    left.append(el("span", "repo-name", [el("b", null, S.state.repo.name), el("i", null, S.state.repo.path)]));
    left.append(branchPill());
    bar.append(left);

    bar.append(el("span", "flex-1"));
    bar.append(syncGroup());

    const right = el("div", "top-right");
    if (S.state.lock.holder) {
      const lockChip = el("span", "lock-chip");
      lockChip.innerHTML = GW.icon("lock", 13) + "<span>仓库锁被占用</span>";
      right.append(lockChip);
    }
    const script = btn("top-btn", null, () => {
      GW.menu(script, [
        { label: "剧本：远端出现新提交", icon: "sync", disabled: S.state.remotePendingUsed,
          onClick: () => GW.report(ops.scriptRemote()) },
        { label: "剧本：agent 占用仓库锁 6 秒", icon: "lock", disabled: !!S.state.lock.holder,
          onClick: () => GW.report(ops.scriptAgentLock()) },
        { sep: true },
        { label: "重置整个 demo", icon: "undo", onClick: () => location.reload() },
      ]);
    });
    script.innerHTML = GW.icon("play", 14) + "<span>演示剧本</span>";
    right.append(script);
    const about = btn("top-btn", null, () => GW.overlays.about.open());
    about.innerHTML = GW.icon("ai", 14) + "<span>设计说明</span>";
    right.append(about);
    bar.append(right);
  }

  /* ---------- 进行中横幅 ---------- */
  function renderBanner() {
    const zone = document.getElementById("opbanner");
    zone.innerHTML = "";
    const opn = S.state.operation;
    if (opn) {
      const left = opn.files.reduce((n, f) => n + f.blocks.filter((x) => !x.choice).length, 0);
      const banner = el("div", "banner banner-conflict");
      banner.innerHTML = GW.icon("warn", 15) + "<b>" + opn.typeLabel + "进行中</b><span>"
        + opn.source + " → " + opn.target + (left ? "，剩 " + left + " 个冲突块" : "，冲突已全部解决") + "</span>";
      const openBtn = btn("mini-btn", left ? "打开冲突解决器" : "去完成" + opn.typeLabel, () => GW.overlays.conflict.open());
      const abortBtn = btn("mini-btn tone-danger", "中止", async () => {
        const okGo = await GW.confirmDialog({
          title: "中止" + opn.typeLabel + "？", body: "工作区回到开始前的状态。", confirmText: "中止", safety: false,
        });
        if (okGo) GW.report(ops.abortOperation());
      });
      banner.append(el("span", "flex-1"), openBtn, abortBtn);
      zone.append(banner);
    }
    if (S.state.lock.holder) {
      const lock = el("div", "banner banner-lock");
      lock.innerHTML = GW.icon("lock", 15) + "<b>" + S.state.lock.holder.reason + "</b>"
        + "<span>agent 持有仓库锁；你此刻发起的操作会自动排队，完成后依次执行"
        + (S.state.lock.queue.length ? "（" + S.state.lock.queue.length + " 个在排队）" : "") + "</span>";
      zone.append(lock);
    }
  }

  /* ---------- 导航 ---------- */
  function renderNav() {
    const nav = document.getElementById("sidenav");
    nav.innerHTML = "";
    VIEW_ORDER.forEach((key) => {
      const v = GW.views[key];
      const b = btn("nav-item ui-selectable" + (GW.app.view === key ? " is-selected" : ""), null, () => GW.app.go(key));
      const badge = v.badge && v.badge();
      b.innerHTML = GW.icon(v.icon, 16) + "<span>" + v.title + "</span>" + (badge ? '<em class="nav-badge">' + badge + "</em>" : "");
      nav.append(b);
    });
  }

  /* ---------- 路由与渲染 ---------- */
  GW.app = {
    view: "changes",
    go(name) { this.view = name; this.render(); },
    render() {
      const active = document.activeElement;
      const focusId = active && active.id;
      const selStart = active && active.selectionStart != null ? active.selectionStart : null;
      const scrolls = {};
      document.querySelectorAll("[data-scroll-key]").forEach((n) => { scrolls[n.dataset.scrollKey] = n.scrollTop; });

      renderTopbar();
      renderBanner();
      renderNav();
      const view = document.getElementById("view");
      view.innerHTML = "";
      GW.views[this.view].render(view);

      document.querySelectorAll("[data-scroll-key]").forEach((n) => {
        if (scrolls[n.dataset.scrollKey] != null) n.scrollTop = scrolls[n.dataset.scrollKey];
      });
      if (focusId) {
        const node = document.getElementById(focusId);
        if (node) {
          node.focus();
          if (selStart != null && node.setSelectionRange) node.setSelectionRange(selStart, selStart);
        }
      }
    },
  };

  S.subscribe(() => GW.app.render());
  GW.app.render();
})();
