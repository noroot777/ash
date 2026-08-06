/* 一个旋钮 —— 第一层：把「这活我要盯多紧」直接做成控件。
   五档各是一条现成的流程；两个开关管剩下的两件事。细节全在 deep.js 的第二层。 */
(function (global) {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;

  // 档位从左到右只加东西，不换东西 —— 这样拖动时线是「长出来」的，不是「变了个样」
  var LEVELS = [
    { name: "只干活", say: "交给 AI 干完就算完。改动留在分支上，你什么时候想起来什么时候看。",
      build: ["run"] },
    { name: "干完自查", say: "干完再让另一个 AI 复查一遍，没过就自己重来，还是不打扰你。",
      build: ["run", "verify"] },
    { name: "我看一眼", say: "复查过了就停下等你。你不点头，它不往下走。",
      build: ["run", "verify", "human"] },
    { name: "先起预览", say: "停下等你之前先把页面跑起来，你能真的点开看，而不是只看一段 diff。",
      build: ["run", "verify", "preview", "human"] },
    { name: "点头就合并", say: "你点通过，它自己合并回主干、删掉 worktree 和任务分支。",
      build: ["run", "verify", "preview", "human", "accept"] },
  ];

  var level = 4, retry = true, custom = false;

  var el = {
    lv: document.getElementById("lv"), ticks: document.getElementById("ticks"),
    say: document.getElementById("say"), flow: document.getElementById("flow"),
    cost: document.getElementById("cost"), sw: document.getElementById("sw"),
  };

  // ── 按档位重新生成 ──────────────────────────────────────────────────
  function build() {
    S.steps = [];
    LEVELS[level - 1].build.forEach(function (kind) { WF.insert(kind); });
    var hasPreview = level >= 4;
    S.steps.forEach(function (s) {
      if (s.kind === "verify" && hasPreview) s.p.checks = ["构建 + 类型检查", "浏览器真实点检"];
    });
    applyRetry();
    custom = false;
  }

  function applyRetry() {
    var first = S.steps[0];
    S.steps.forEach(function (s) {
      if (s.kind !== "verify" && s.kind !== "human") return;
      s.fail = retry && first
        ? { mode: "back", backTo: first.id, max: 2 }
        : { mode: "stop", backTo: null, max: 2 };
    });
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function renderTicks() {
    el.ticks.innerHTML = LEVELS.map(function (l, i) {
      return '<button data-lv="' + (i + 1) + '" data-on="' + (i + 1 === level) + '">' + esc(l.name) + "</button>";
    }).join("");
  }

  function renderSay() {
    el.say.innerHTML = '<b>' + esc(LEVELS[level - 1].name) + "</b>" +
      "<span>" + esc(custom ? "已经在下面改过，这段说明只是这一档的原样。" : LEVELS[level - 1].say) + "</span>";
  }

  function tone(hue) { return hue; }

  function renderFlow() {
    var h = [];
    S.steps.forEach(function (s) {
      var k = K[s.kind], st = WFSIM.STATUS[s.kind];
      h.push('<div class="chip" style="--tone:' + tone(k.hue) + '" data-k="' + s.kind + '">' +
        '<span class="dot"></span><b>' + esc(k.title(s.p)) + "</b>" +
        '<span class="st">任务显示 ' + esc(st.text) + "</span></div>");
    });
    el.flow.innerHTML = h.join("");
  }

  function renderCost() {
    if (!S.steps.length) { el.cost.innerHTML = ""; return; }
    var ok = WFSIM.run(S.steps, {});
    var bad = WFSIM.worst(S.steps);
    var last = S.steps[S.steps.length - 1];
    el.cost.innerHTML =
      '<span class="one"><em>' + ok.stats.steps + "</em>步<i>顺利的话</i></span>" +
      '<span class="one"><em>' + (ok.stats.gates + ok.stats.asks) + "</em>次要你出面<i>剩下的它自己扛</i></span>" +
      '<span class="one"><em>' + bad.aiRuns + "</em>次起 AI<i>一直不过的话，最多</i></span>" +
      '<span class="tail">' + esc(last.kind === "accept" ? "走到底就合并完了" : "走到底任务落 done，改动等你处理") + "</span>";
  }

  function renderSwitches() {
    var canRetry = S.steps.some(function (s) { return s.kind === "verify" || s.kind === "human"; });
    var h = [];
    h.push(row("retry", retry, "没过就让它自己重来", canRetry
      ? "回到第一步重做，最多 2 轮；2 轮还不过才叫你。"
      : "这一档没有任何检查关口，没有「没过」这回事。", !canRetry));
    h.push(row("ws", S.workspace === "isolated", "在独立 worktree 里干",
      S.workspace === "isolated" ? "不碰你正开着的项目目录，改完再合回去。"
        : "直接在项目目录里改 —— 快，但你自己也在这儿工作。", false));
    el.sw.innerHTML = h.join("");
  }
  function row(key, on, title, desc, dim) {
    return '<button class="sw" data-sw="' + key + '" data-on="' + on + '"' + (dim ? " disabled" : "") + '>' +
      '<span class="knob"></span><span class="txt"><b>' + esc(title) + "</b><em>" + esc(desc) + "</em></span></button>";
  }

  function render() {
    el.lv.value = String(level);
    el.lv.style.setProperty("--fill", ((level - 1) / 4 * 100) + "%");
    renderTicks(); renderSay(); renderFlow(); renderCost(); renderSwitches();
    if (global.WFDEEP) global.WFDEEP.render();
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  el.lv.addEventListener("input", function () {
    var v = Number(el.lv.value);
    if (v === level) return;
    level = v; build(); render();
  });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-lv],[data-sw]");
    if (!t) return;
    if (t.dataset.lv) { level = Number(t.dataset.lv); build(); render(); return; }
    if (t.dataset.sw === "retry") { retry = !retry; applyRetry(); render(); return; }
    if (t.dataset.sw === "ws") { S.workspace = S.workspace === "isolated" ? "shared" : "isolated"; render(); }
  });

  global.WFDIAL = {
    refresh: function (isCustom) { if (isCustom) custom = true; render(); },
    levelName: function () { return LEVELS[level - 1].name; },
  };

  build();
  render();
})(window);
