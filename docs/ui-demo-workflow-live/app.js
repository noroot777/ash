/* 执行态回放 —— 输入还是那份编排（../ui-demo-workflow-kit/model.js），
   推演还是那台预演引擎（sim.js）。这里只做一件事：把 sim 吐出的事件序列
   摊回到编排图的同一批坐标上，让「计划」和「实况」共用一张图。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {
    rail: document.getElementById("rail"), tl: document.getElementById("tl"),
    list: document.getElementById("list"), badge: document.getElementById("badge"),
    from: document.getElementById("from"), clock: document.getElementById("clock"),
    scrub: document.getElementById("scrub"), play: document.getElementById("play"),
    rew: document.getElementById("rew"), hard: document.getElementById("hard"),
  };

  WF.loadTemplate("frontend");
  var steps = S.steps;
  var ev = [], end = null, t = 0, timer = null;

  // 每一关大概占多久（秒）—— 只为让时间轴上的钟走得像回事
  var SEC = { run: 214, verify: 96, preview: 11, human: 320, command: 37, accept: 4 };

  function build() {
    var assume = {};
    if (el.hard.checked) {
      steps.forEach(function (s) { if (s.kind === "verify") assume[s.id] = "once"; });
    }
    var r = WFSIM.run(steps, assume);
    ev = r.events; end = r.end;
    el.scrub.max = String(ev.length);
    if (t > ev.length) t = ev.length;
    stamp();
  }

  // 每条事件发生的时刻，从 14:02:00 起累加
  function stamp() {
    var sec = 0;
    ev.forEach(function (e, i) {
      e.at = sec;
      sec += e.jump != null ? 2 : e.fail ? 1 : (SEC[e.kind] || 20);
    });
    ev.tot = sec;
  }
  function hhmm(sec) {
    var s = 14 * 3600 + 2 * 60 + sec;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(Math.floor(s / 3600) % 24) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60);
  }

  // ── 把事件前缀折算成「每一站现在是什么样」 ─────────────────────────
  function frame() {
    var map = {}, arcs = [];
    steps.forEach(function (s) { map[s.id] = { s: "pending" }; });
    var upto = Math.min(t, ev.length - 1);
    for (var i = 0; i <= upto; i++) {
      var e = ev[i];
      if (e.jump != null) {                      // 往回拐：中间那几站清空重来
        for (var k = e.jump; k <= e.idx; k++) map[steps[k].id] = { s: "pending" };
        arcs.push({ from: e.idx, to: e.jump, round: e.round, max: steps[e.idx].fail.max });
        continue;
      }
      if (e.fail) { map[e.id] = { s: "bad", round: e.round }; continue; }
      map[e.id] = { s: "done", round: e.round };
    }
    var last = ev[upto] || null;
    if (t < ev.length && last && last.jump == null && !last.fail) {
      map[last.id].s = last.kind === "human" ? "wait" : last.kind === "accept" ? "done" : "now";
    }
    // 回拐那一瞬间：中间几站已清空，把要重来的那一站先点亮，别让整条线一起熄掉
    if (t < ev.length && last && last.jump != null) map[steps[last.jump].id].s = "now";
    return { map: map, arcs: arcs, last: last, over: t >= ev.length };
  }

  // ── 详情页的线路图 ─────────────────────────────────────────────────
  var SLOT = { done: "", bad: "没过", wait: "等你点头", pending: "" };
  function railHtml(f) {
    var h = [];
    steps.forEach(function (s, i) {
      var st = f.map[s.id], k = K[s.kind];
      var lit = i > 0 && f.map[steps[i - 1].id].s === "done";
      var slot = st.s === "now" ? WFSIM.STATUS[s.kind].text : SLOT[st.s];
      if (st.s === "done" && st.round > 1) slot = "第 " + st.round + " 轮 ✓";
      h.push('<div class="col" data-s="' + st.s + '" data-lit="' + lit + '">' +
        '<div class="node"><b>' + (st.s === "done" ? "✓" : i + 1) + "</b></div>" +
        '<div class="nm">' + esc(k.title(s.p)) + "</div>" +
        '<div class="sl">' + esc(slot) + "</div></div>");
    });
    f.arcs.forEach(function (a) {
      // 左右各内缩半列，让弧的两端正好落在节点圆心上
      var inset = 50 / (a.from - a.to + 1);
      h.push('<div class="arc" style="grid-column:' + (a.to + 1) + "/" + (a.from + 2) +
        ";margin-left:" + inset + "%;margin-right:" + inset + '%">' +
        "<span>没过 → 回第 " + (a.to + 1) + " 站 · 第 " + (a.round + 1) + " 轮 / 上限 " + a.max + "</span></div>");
    });
    el.rail.style.gridTemplateColumns = "repeat(" + steps.length + ",1fr)";
    el.rail.innerHTML = h.join("");
  }

  function tlHtml(f) {
    var upto = Math.min(t, ev.length - 1), h = [];
    for (var i = 0; i <= upto; i++) {
      var e = ev[i];
      h.push('<div class="ev" data-tone="' + e.tone + '" data-cur="' + (i === upto && !f.over) + '">' +
        '<span class="t">' + hhmm(e.at).slice(0, 5) + '</span><span class="d"></span>' +
        "<span><b>" + esc(e.label) + "</b> · " + esc(e.status) +
        (e.round > 1 && e.jump == null ? " · 第 " + e.round + " 轮" : "") +
        '<br><span class="n">' + esc(e.note) + "</span></span></div>");
    }
    if (f.over) {
      h.push('<div class="ev end" data-tone="' + end.tone + '"><span class="t">' +
        hhmm(ev.tot).slice(0, 5) + '</span><span class="d"></span><span><b>' + esc(end.text) + "</b></span></div>");
    }
    el.tl.innerHTML = h.join("");
    el.tl.scrollTop = el.tl.scrollHeight;
  }

  // ── 任务列表：同一条线退化成一根条 ────────────────────────────────
  var OTHERS = [
    { t: "修 mobile 会话轮询偶尔丢消息", who: "claude", n: 4, at: 2, s: "审查中", tone: "run" },
    { t: "日报流水线接上 tts 那一段", who: "codex@cpa", n: 1, at: 0, s: "运行中", tone: "run" },
    { t: "批量重命名 scripts 里的旧路径", who: "claude", n: 5, at: 5, s: "已验收", tone: "good" },
  ];
  function bar(cells) {
    return '<div class="bar">' + cells.map(function (c) {
      return '<u data-s="' + c + '"></u>';
    }).join("") + "</div>";
  }
  // 任务整体在列表/徽章上显示的那一个词 —— 详情和列表必须是同一句话
  function stateOf(f) {
    if (f.over) {
      return { tone: end.tone, text: end.tone === "good" ? "已验收" : end.tone === "wait" ? "需你处理" : "已失败" };
    }
    var l = f.last;
    if (!l) return { tone: "run", text: "排队中" };
    if (l.jump != null) return { tone: "run", text: "运行中 · 第 " + (l.round + 1) + " 轮" };
    return { tone: l.tone, text: l.status };
  }

  function listHtml(f) {
    var live = steps.map(function (s) { return f.map[s.id].s; });
    var w = stateOf(f);
    var h = ['<div class="row" data-live="true" title="' +
      esc(steps.map(function (s) { return K[s.kind].title(s.p); }).join(" → ")) + '">' +
      '<span class="tt">给设置页加「工作流」入口</span>' +
      '<span class="who">codex@cpa</span>' + bar(live) +
      '<span class="stt" data-tone="' + w.tone + '">' + esc(w.text) + "</span></div>"];
    OTHERS.forEach(function (o) {
      var cells = [];
      for (var i = 0; i < o.n; i++) cells.push(i < o.at ? "done" : i === o.at ? "now" : "pending");
      if (o.at >= o.n) cells = cells.map(function () { return "done"; });
      h.push('<div class="row"><span class="tt">' + esc(o.t) + '</span><span class="who">' +
        esc(o.who) + "</span>" + bar(cells) +
        '<span class="stt" data-tone="' + o.tone + '">' + esc(o.s) + "</span></div>");
    });
    el.list.innerHTML = h.join("");
  }

  function render() {
    var f = frame();
    railHtml(f); tlHtml(f); listHtml(f);
    var w = stateOf(f);
    el.badge.setAttribute("data-tone", w.tone);
    el.badge.textContent = w.text;
    el.from.textContent = "这条线 · 前端真实验收（跟随本项目）";
    el.clock.textContent = hhmm(f.over ? ev.tot : (f.last ? f.last.at : 0));
    el.scrub.value = String(t);
    el.play.textContent = timer ? "❚❚ 停" : t >= ev.length ? "↻ 再放一遍" : "▶ 放一遍";
  }

  // ── 遥控 ──────────────────────────────────────────────────────────
  function stop() { clearInterval(timer); timer = null; render(); }
  function tick() { if (t >= ev.length) return stop(); t++; render(); }
  el.play.addEventListener("click", function () {
    if (timer) return stop();
    if (t >= ev.length) t = 0;
    timer = setInterval(tick, 950);
    tick();
  });
  el.rew.addEventListener("click", function () { t = 0; stop(); });
  el.scrub.addEventListener("input", function () { t = Number(el.scrub.value); stop(); });
  el.hard.addEventListener("change", function () { t = 0; build(); stop(); });

  build();
  render();
})();
