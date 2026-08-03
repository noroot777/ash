/* ui-demo2 共享脚本:注入导航条 / 选中态切换器 / 侧边栏(含任务树) / 设置页专用窄栏,并绑定交互。
   选中态方案存 localStorage(ud2-sel),跨页面保持。零外部依赖。 */
(function () {
  "use strict";

  var PAGES = [
    ["index.html", "总览"],
    ["shell.html", "主视图"],
    ["task.html", "单任务·队列抽屉"],
    ["team.html", "团队调度台"],
    ["debate.html", "辩论"],
    ["review.html", "单任务验收"],
    ["review-team.html", "团队验收"],
    ["composer.html", "新建任务"],
    ["notes.html", "随手记"],
    ["palette.html", "⌘K"],
    ["components.html", "控件对照"],
    ["workflow-codex.html", "工作流·Codex"],
    ["settings-agents.html", "设置·智能体"],
    ["settings-project.html", "设置·项目"],
    ["settings-groups.html", "设置·分组"],
    ["settings-archive.html", "设置·归档"],
  ];

  /* ── 模板:侧边栏任务树行。sel = 选中行 id;行是真链接,可直接当产品点 ── */
  function trow(href, id, sel, chev, title, meta, dot) {
    return (
      '<a class="trow selectable' + (sel === id ? " selected" : "") + '" href="' + href + '"' +
      (sel === id ? ' aria-current="page"' : "") + ">" +
      '<span class="chev">' + (chev || "") + "</span>" +
      '<div class="tmain"><b>' + title + "</b><small>" + meta + "</small></div>" +
      '<i class="mdot ' + dot + '"></i></a>'
    );
  }

  /* ── 模板:单一侧边栏(Linear 式)。顶部项目切换器 + 三图标,主体 = 当前项目任务树,
        再往下「其他项目」折叠行,底部连接状态。 ── */
  function sidebarHTML(sel) {
    return (
      '<aside class="sidebar">' +
      '<div class="side-top">' +
      '<button class="proj-trigger" data-action="project" aria-expanded="false" aria-label="切换项目">' +
      '<span class="proj-avatar">H</span><span class="proj-name">harness</span><span class="proj-caret">▾</span></button>' +
      '<a class="tool-btn" href="palette.html" title="搜索 ⌘K" aria-label="搜索 ⌘K">⌕</a>' +
      '<a class="tool-btn" href="notes.html" title="随手记" aria-label="随手记">▤</a>' +
      '<a class="tool-btn" href="composer.html" title="新建任务" aria-label="新建任务">✎</a>' +
      "</div>" +
      '<nav class="side-scroll" aria-label="任务树">' +
      '<div class="lsec">协作任务</div>' +
      '<div class="lgroup">进行中<em>2</em></div>' +
      trow("team.html", "team1", sel, "▾", "自动验证相关 - 依旧大改", "团队 · 1 干活 · 1 排队 · 1 完成", "green") +
      '<div class="wsub">' +
      trow("team.html", "w1", sel, "", "审查者机制:shared 层", "codex@cpa · 完成", "gray") +
      trow("team.html", "w2", sel, "", "审查者机制:web 接入", "codex@cpa · 干活中", "green") +
      trow("team.html", "w3", sel, "", "审查:全链路真实运行", "codex@cpa · 排队", "amber") +
      "</div>" +
      trow("debate.html", "debate1", sel, "▸", "评审:回复框交互方案", "辩论 · 第 2 轮进行中", "indigo") +
      '<div class="lgroup">已验收<em>1</em></div>' +
      trow("review-team.html", "accepted1", sel, "▸", "移动端会话贴底重构", "团队 · 已合并 · 07/28", "gray") +
      '<div class="lsec">普通任务</div>' +
      '<div class="lgroup">运行中<em>1</em></div>' +
      trow("task.html", "run1", sel, "", "接入 SSE 断线重连", "claude@ccb · 12m", "green") +
      '<div class="lgroup">提问中<em>1</em></div>' +
      trow("task.html", "ask1", sel, "", "清理 worktree 兜底逻辑", "等你拍板 · 2 个问题", "cyan") +
      '<div class="lgroup">已完成<em>3</em></div>' +
      trow("review.html", "reviewSingle", sel, "", "按源码重做验收工作区", "verified · 待验收", "green") +
      trow("shell.html", "done1", sel, "", "修复回复框顶边拖高失效", "verified · 42m 17s", "gray") +
      trow("shell.html", "done2", sel, "", "接回调度者含义说明", "已验收 · 7m 40s", "gray") +
      '<div class="lsec">其他项目</div>' +
      '<div class="oproj open">' +
      '<button class="oproj-head" data-action="oproj" aria-expanded="true">' +
      '<span class="chev">▾</span><span class="proj-avatar sm g2">D</span>dr-pipeline<span class="count">3</span></button>' +
      trow("palette.html", "dr1", sel, "", "daily-report:视频条目化流水线", "运行中 · 23m", "green") +
      trow("palette.html", "dr2", sel, "", "dr 日报模板改版", "已完成 · 昨天", "gray") +
      "</div>" +
      '<div class="oproj">' +
      '<button class="oproj-head" data-action="oproj" aria-expanded="false">' +
      '<span class="chev">▸</span><span class="proj-avatar sm g3">M</span>mobile-app<span class="count">2</span></button>' +
      trow("palette.html", "mb1", sel, "", "审查徽标接到移动端", "backlog", "gray") +
      trow("palette.html", "mb2", sel, "", "会话页下拉刷新手感", "已完成 · 07/27", "gray") +
      "</div>" +
      "</nav>" +
      '<div class="side-bottom">' +
      '<div class="side-conn"><i></i>实时已连接</div>' +
      '<button class="side-fold">⇤ 收起</button>' +
      "</div>" +
      '<div class="proj-scrim" data-action="project-close"></div>' +
      '<div class="proj-pop" role="menu" aria-label="项目切换">' +
      '<div class="pp-current"><span class="proj-avatar lg">H</span>' +
      "<div><b>harness</b><small>~/code/harness</small></div>" +
      '<a class="pp-gear" href="settings-project.html" aria-label="设置">⚙</a></div>' +
      '<a class="pp-row pp-settings" href="settings-project.html"><span class="pp-ico">⚙</span>设置<small>智能体 · 项目 · 分组 · 归档</small></a>' +
      '<input class="pp-search" placeholder="搜索项目…" aria-label="搜索项目">' +
      '<div class="pp-label">切换到</div>' +
      '<div class="pp-row selectable selected"><span class="proj-avatar">H</span>harness<span class="pp-tag">当前</span></div>' +
      '<div class="pp-row selectable"><span class="proj-avatar g2">D</span>dr-pipeline<small>~/code/dr-pipeline</small></div>' +
      '<div class="pp-row selectable"><span class="proj-avatar g3">M</span>mobile-app<small>~/code/mobile-app</small></div>' +
      '<div class="pp-row selectable"><span class="proj-avatar g4">K</span>kb-vault<small>~/code/kb-vault</small></div>' +
      '<button class="pp-foot"><i>＋</i>新建项目</button>' +
      "</div></aside>"
    );
  }

  /* ── 模板:设置页专用窄栏(单开页外壳,独立于主应用侧边栏) ── */
  function setItem(href, key, active, label) {
    return (
      '<a class="set-item' + (active === key ? " selectable selected" : "") + '" href="' + href + '"' +
      (active === key ? ' aria-current="page"' : "") + ">" + label + "</a>"
    );
  }
  function settingsSideHTML(active) {
    return (
      '<aside class="set-side">' +
      '<a class="set-back" href="shell.html"><span>←</span>返回应用</a>' +
      '<input class="set-search" placeholder="搜索设置…" aria-label="搜索设置">' +
      '<nav aria-label="设置导航">' +
      '<div class="set-group">智能体</div>' +
      setItem("settings-agents.html", "profiles", active, "执行器 Profile") +
      setItem("settings-agents.html#rules", "rules", active, "默认规则") +
      setItem("settings-agents.html#claude", "claude", active, "claude") +
      setItem("settings-agents.html#codex", "codex", active, "codex") +
      '<div class="set-group">编排</div>' +
      setItem("workflow-codex.html", "workflows", active, "工作流模板") +
      '<div class="set-group">项目</div>' +
      setItem("settings-project.html", "project", active, "项目设置") +
      setItem("settings-groups.html", "groups", active, "分组") +
      setItem("settings-archive.html", "archive", active, "已归档") +
      "</nav></aside>"
    );
  }

  /* ── 注入 data-include 占位 ── */
  document.querySelectorAll("[data-include]").forEach(function (node) {
    var kind = node.getAttribute("data-include");
    if (kind === "sidebar") node.outerHTML = sidebarHTML(node.getAttribute("data-selected") || "");
    else if (kind === "settings-side") node.outerHTML = settingsSideHTML(node.getAttribute("data-active") || "");
  });

  /* ── 注入顶部演示导航条 ── */
  var here = (location.pathname.split("/").pop() || "index.html");
  var bar =
    '<nav class="demo-bar" aria-label="演示页导航"><span class="db-brand"><i>H</i>UI 讨论稿 · R7</span>' +
    PAGES.map(function (p) {
      return '<a href="' + p[0] + '"' + (p[0] === here ? ' class="current"' : "") + ">" + p[1] + "</a>";
    }).join("") +
    '<span class="db-note">静态演示 · 右下角切换选中态</span></nav>';
  document.body.insertAdjacentHTML("afterbegin", bar);
  document.body.classList.add("has-demo-bar");

  /* ── 注入方案切换器 + 恢复保存的选择 ── */
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* file:// 下个别浏览器禁用,忽略 */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var SEL = ["s1", "s2", "s3"];
  var curSel = SEL.indexOf(load("ud2-sel")) >= 0 ? load("ud2-sel") : "s1";

  function applyScheme() {
    SEL.forEach(function (s) { document.body.classList.toggle("sel-" + s, s === curSel); });
    document.querySelectorAll(".scheme-switch [data-sel]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-sel") === curSel));
    });
  }

  document.body.insertAdjacentHTML(
    "beforeend",
    '<aside class="scheme-switch" aria-label="方案切换器">' +
    '<div class="ss-head">方案切换<button data-action="switch-min" aria-label="收起切换器">−</button></div>' +
    '<div class="ss-row"><div class="ss-label">列表选中态</div><div class="ss-seg">' +
    '<button data-sel="s1">S1 染+条</button><button data-sel="s2">S2 淡染</button><button data-sel="s3">S3 灰</button></div></div>' +
    "</aside>"
  );
  applyScheme();

  /* ── 交互:全局事件委托 ── */
  function closeMenus(except) {
    document.querySelectorAll(".menu-open").forEach(function (n) {
      if (n !== except) {
        n.classList.remove("menu-open");
        var t = n.querySelector('[data-action="menu"]');
        if (t) t.setAttribute("aria-expanded", "false");
      }
    });
  }

  document.addEventListener("click", function (event) {
    var swBtn = event.target.closest(".scheme-switch [data-sel]");
    if (swBtn) {
      curSel = swBtn.getAttribute("data-sel");
      store("ud2-sel", curSel);
      applyScheme();
      return;
    }
    var control = event.target.closest("[data-action]");
    var host = control && control.closest("[data-surface]");
    if (!control || control.getAttribute("data-action") !== "menu") closeMenus(host);
    if (!control) return;
    var action = control.getAttribute("data-action");

    if (action === "switch-min") {
      document.body.classList.toggle("switch-min");
      control.textContent = document.body.classList.contains("switch-min") ? "＋" : "−";
    } else if (action === "project") {
      document.body.classList.toggle("project-open");
      control.setAttribute("aria-expanded", String(document.body.classList.contains("project-open")));
    } else if (action === "project-close") {
      document.body.classList.remove("project-open");
    } else if (action === "oproj") {
      var op = control.closest(".oproj");
      op.classList.toggle("open");
      var opOn = op.classList.contains("open");
      control.setAttribute("aria-expanded", String(opOn));
      control.querySelector(".chev").textContent = opOn ? "▾" : "▸";
    } else if (action === "menu" && host) {
      host.classList.toggle("menu-open");
      control.setAttribute("aria-expanded", String(host.classList.contains("menu-open")));
    } else if (action === "inspector" && host) {
      host.classList.toggle("inspector-off");
      var open = !host.classList.contains("inspector-off");
      host.querySelectorAll('[data-action="inspector"]').forEach(function (b) {
        b.setAttribute("aria-expanded", String(open));
      });
    } else if (action === "timeline" && host) {
      host.classList.toggle("timeline-open");
      var on = host.classList.contains("timeline-open");
      control.querySelectorAll(".tl-caret").forEach(function (c) { c.textContent = on ? "收起 ▴" : "展开 ▾"; });
    } else if (action === "drawer") {
      document.body.classList.add("drawer-open");
    } else if (action === "drawer-close") {
      document.body.classList.remove("drawer-open");
    } else if (action === "qdrawer") {
      document.body.classList.add("qdrawer-open");
    } else if (action === "qdrawer-close") {
      document.body.classList.remove("qdrawer-open");
    } else if (action === "rtab" && host) {
      var pane = control.getAttribute("data-pane");
      host.querySelectorAll('[data-action="rtab"]').forEach(function (b) {
        b.setAttribute("aria-selected", String(b === control));
      });
      host.querySelectorAll("[data-rpane]").forEach(function (p) {
        p.classList.toggle("rpane-on", p.getAttribute("data-rpane") === pane);
      });
    } else if (action === "mode" && host) {
      var mode = control.getAttribute("data-mode");
      ["single", "team", "debate"].forEach(function (m) { host.classList.toggle("mode-" + m, m === mode); });
      host.querySelectorAll('[data-action="mode"]').forEach(function (b) {
        b.setAttribute("aria-selected", String(b === control));
      });
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    document.body.classList.remove("project-open", "drawer-open", "qdrawer-open");
    closeMenus(null);
  });
})();
