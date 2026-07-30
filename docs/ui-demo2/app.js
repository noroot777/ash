/* ui-demo2 共享脚本:注入导航条 / 方案切换器 / 项目栏 / 任务列表模板,并绑定交互。
   方案选择存 localStorage(ud2-sel / ud2-gray),跨页面保持。零外部依赖。 */
(function () {
  "use strict";

  var PAGES = [
    ["index.html", "总览"],
    ["shell.html", "主视图·项目切换"],
    ["task.html", "单任务详情"],
    ["team.html", "团队调度台"],
    ["debate.html", "辩论视图"],
    ["review.html", "验收 Diff"],
    ["composer.html", "新建任务"],
    ["notes.html", "随手记"],
    ["palette.html", "命令面板 ⌘K"],
    ["panels.html", "设置类 Modal"],
  ];

  /* ── 模板:ProjectRail(第 1 栏,含项目下拉) ── */
  function railHTML() {
    return (
      '<aside class="rail">' +
      '<button class="proj-trigger" data-action="project" aria-expanded="false" aria-label="切换项目">' +
      '<span class="proj-avatar">H</span><span class="proj-name">harness</span><span class="proj-caret">▾</span></button>' +
      '<div class="rail-sec">执行</div>' +
      '<div class="rail-item active"><i class="ri">☰</i>任务<span class="count">12</span></div>' +
      '<div class="rail-flex"></div>' +
      '<div class="rail-bottom">' +
      '<button class="rail-item"><i class="ri">◎</i>智能体</button>' +
      '<button class="rail-item"><i class="ri">⌕</i>搜索<kbd>⌘K</kbd></button>' +
      '<div class="rail-conn"><i></i>实时已连接</div>' +
      '<button class="rail-item"><i class="ri">⇤</i>收起侧栏</button>' +
      "</div>" +
      '<div class="proj-scrim" data-action="project-close"></div>' +
      '<div class="proj-pop" role="menu" aria-label="项目切换">' +
      '<div class="pp-current"><span class="proj-avatar lg">H</span>' +
      "<div><b>harness</b><small>~/code/harness</small></div>" +
      '<button class="pp-gear" aria-label="项目设置">⚙</button></div>' +
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

  /* ── 模板:任务列表(第 2 栏)。sel = 选中行 id ── */
  function trow(id, sel, chev, title, meta, dot) {
    return (
      '<div class="trow selectable' + (sel === id ? " selected" : "") + '" data-id="' + id + '">' +
      '<span class="chev">' + (chev || "") + "</span>" +
      '<div class="tmain"><b>' + title + "</b><small>" + meta + "</small></div>" +
      '<i class="mdot ' + dot + '"></i></div>'
    );
  }
  function listHTML(sel) {
    return (
      '<section class="list-col"><div class="list-head">' +
      '<span class="branch-chip"><b>harness/pSHdnpMo</b><span class="wt">·wt</span></span>' +
      '<button class="lh-btn" aria-label="新建任务">✎</button><span class="lh-spacer"></span>' +
      '<button class="lh-btn" aria-label="随手记">✐</button>' +
      '<button class="lh-btn" aria-label="分组">⊞</button>' +
      '<button class="lh-btn" aria-label="列表 / 已归档">▣</button>' +
      "</div>" +
      '<div class="list-scroll">' +
      '<div class="lsec">协作任务</div>' +
      '<div class="lgroup">进行中<em>2</em></div>' +
      trow("team1", sel, "▾", "自动验证相关 - 依旧大改", "团队 · 1 干活 · 1 排队 · 1 完成", "green") +
      '<div class="wsub">' +
      trow("w1", sel, "", "审查者机制:shared 层", "codex@cpa · 完成", "gray") +
      trow("w2", sel, "", "审查者机制:web 接入", "codex@cpa · 干活中", "green") +
      trow("w3", sel, "", "审查:全链路真实运行", "codex@cpa · 排队", "amber") +
      "</div>" +
      trow("debate1", sel, "▸", "评审:回复框交互方案", "辩论 · 第 2 轮进行中", "indigo") +
      '<div class="lgroup">已验收<em>1</em></div>' +
      trow("accepted1", sel, "▸", "移动端会话贴底重构", "团队 · 已合并 · 07/28", "gray") +
      '<div class="lsec">普通任务</div>' +
      '<div class="lgroup">运行中<em>1</em></div>' +
      trow("run1", sel, "", "接入 SSE 断线重连", "claude@ccb · 12m", "green") +
      '<div class="lgroup">提问中<em>1</em></div>' +
      trow("ask1", sel, "", "清理 worktree 兜底逻辑", "等你拍板 · 2 个问题", "cyan") +
      '<div class="lgroup">已完成<em>2</em></div>' +
      trow("done1", sel, "", "修复回复框顶边拖高失效", "verified · 42m 17s", "gray") +
      trow("done2", sel, "", "接回调度者含义说明", "已验收 · 7m 40s", "gray") +
      "</div></section>"
    );
  }

  /* ── 注入 data-include 占位 ── */
  document.querySelectorAll("[data-include]").forEach(function (node) {
    var kind = node.getAttribute("data-include");
    if (kind === "rail") node.outerHTML = railHTML();
    else if (kind === "tasklist") node.outerHTML = listHTML(node.getAttribute("data-selected") || "");
  });

  /* ── 注入顶部演示导航条 ── */
  var here = (location.pathname.split("/").pop() || "index.html");
  var bar =
    '<nav class="demo-bar" aria-label="演示页导航"><span class="db-brand"><i>H</i>UI 讨论稿 v2</span>' +
    PAGES.map(function (p) {
      return '<a href="' + p[0] + '"' + (p[0] === here ? ' class="current"' : "") + ">" + p[1] + "</a>";
    }).join("") +
    '<span class="db-note">静态演示 · 右下角切换方案</span></nav>';
  document.body.insertAdjacentHTML("afterbegin", bar);
  document.body.classList.add("has-demo-bar");

  /* ── 注入方案切换器 + 恢复保存的选择 ── */
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* file:// 下个别浏览器禁用,忽略 */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  var SEL = ["s1", "s2", "s3"], GRAY = ["base", "deep"];
  var curSel = SEL.indexOf(load("ud2-sel")) >= 0 ? load("ud2-sel") : "s1";
  var curGray = GRAY.indexOf(load("ud2-gray")) >= 0 ? load("ud2-gray") : "base";

  function applyScheme() {
    SEL.forEach(function (s) { document.body.classList.toggle("sel-" + s, s === curSel); });
    document.body.classList.toggle("gray-deep", curGray === "deep");
    document.querySelectorAll(".scheme-switch [data-sel]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-sel") === curSel));
    });
    document.querySelectorAll(".scheme-switch [data-gray]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-gray") === curGray));
    });
  }

  document.body.insertAdjacentHTML(
    "beforeend",
    '<aside class="scheme-switch" aria-label="方案切换器">' +
    '<div class="ss-head">方案切换<button data-action="switch-min" aria-label="收起切换器">−</button></div>' +
    '<div class="ss-row"><div class="ss-label">列表选中态</div><div class="ss-seg">' +
    '<button data-sel="s1">S1 染+条</button><button data-sel="s2">S2 淡染</button><button data-sel="s3">S3 灰</button></div></div>' +
    '<div class="ss-row"><div class="ss-label">灰阶</div><div class="ss-seg">' +
    '<button data-gray="base">现状版</button><button data-gray="deep">加深版</button></div></div>' +
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
    var swBtn = event.target.closest(".scheme-switch [data-sel],.scheme-switch [data-gray]");
    if (swBtn) {
      if (swBtn.hasAttribute("data-sel")) { curSel = swBtn.getAttribute("data-sel"); store("ud2-sel", curSel); }
      else { curGray = swBtn.getAttribute("data-gray"); store("ud2-gray", curGray); }
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
    document.body.classList.remove("project-open", "drawer-open");
    closeMenus(null);
  });
})();
