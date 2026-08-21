/* 执行态回放 —— 输入还是那份编排（../ui-demo-workflow-kit/model.js），
   推演还是那台预演引擎（sim.js）。这里只做一件事：把 sim 吐出的事件序列
   摊回到编排图的同一批站上，让「计划」和「实况」共用一条线。
   区别只在方向：详情页中间是会话，线住进右边 340px 的 Inspector，所以竖着走。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {
    rail: document.getElementById("rail"), tl: document.getElementById("tl"),
    list: document.getElementById("list"), badge: document.getElementById("badge"),
    ifrom: document.getElementById("ifrom"), vtitle: document.getElementById("ivtitle"),
    mbody: document.getElementById("mbody"), clock: document.getElementById("clock"),
    scrub: document.getElementById("scrub"), play: document.getElementById("play"),
    rew: document.getElementById("rew"), hard: document.getElementById("hard"),
  };

  WF.loadTemplate("frontend");
  var steps = S.steps;
  var ev = [], end = null, t = 0, timer = null;
  var manual = {};          // 你在人工关口上按下的那一下（通过 / 打回）

  // 每一关大概占多久（秒）—— 只为让时间轴上的钟走得像回事
  var SEC = { run: 214, verify: 96, preview: 11, human: 320, command: 37, accept: 4 };

  function build() {
    var assume = {};
    if (el.hard.checked) {
      steps.forEach(function (s) { if (s.kind === "verify") assume[s.id] = "once"; });
    }
    Object.keys(manual).forEach(function (id) { assume[id] = manual[id]; });
    var r = WFSIM.run(steps, assume);
    ev = r.events; end = r.end;
    el.scrub.max = String(ev.length);
    if (t > ev.length) t = ev.length;
    stamp();
  }

  // 每条事件发生的时刻，从 14:02:00 起累加
  function stamp() {
    var sec = 0;
    ev.forEach(function (e) {
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
  function dur(sec) {
    if (sec >= 60) return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
    return sec + " 秒";
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
      if (e.fail) { map[e.id] = { s: "bad", round: e.round, ei: i }; continue; }
      map[e.id] = { s: "done", round: e.round, ei: i };
    }
    var last = ev[upto] || null;
    if (t < ev.length && last && last.jump == null && !last.fail) {
      map[last.id].s = last.kind === "human" ? "wait" : last.kind === "accept" ? "done" : "now";
    }
    // 回拐那一瞬间：中间几站已清空，把要重来的那一站先点亮，别让整条线一起熄掉
    if (t < ev.length && last && last.jump != null) map[steps[last.jump].id].s = "now";
    return { map: map, arcs: arcs, last: last, over: t >= ev.length };
  }

  // ── Inspector 里的竖版线路 ─────────────────────────────────────────
  function slotOf(s, st) {
    if (st.s === "now") return WFSIM.STATUS[s.kind].text;
    if (st.s === "wait") return "等你点头";
    if (st.s === "bad") return "没过";
    if (st.s === "done") {
      var e = ev[st.ei], next = ev[st.ei + 1];
      var used = next ? next.at - e.at : (SEC[s.kind] || 20);
      return (st.round > 1 ? "第 " + st.round + " 轮 · " : "") + dur(used);
    }
    return "";
  }

  function railHtml(f) {
    var h = [], loopAt = {};
    f.arcs.forEach(function (a) { loopAt[a.to] = a; });

    steps.forEach(function (s, i) {
      var st = f.map[s.id], k = K[s.kind];
      var body = ['<div class="vn"><b>' + esc(k.title(s.p)) + "</b>" +
        '<span class="st">' + esc(slotOf(s, st)) + "</span></div>",
        '<div class="vp">' + esc(k.summary(s.p)) + "</div>"];

      // 竖过来最实在的好处：轮到你了，按钮就长在这一站底下
      if (st.s === "wait") {
        body.push('<div class="vact"><button class="pass" data-act="pass">通过，继续</button>' +
          '<button class="rej" data-act="rej">打回重做</button></div>');
        body.push('<div class="vhint">任务已落「需你处理」并推过通知；' +
          "在这儿按，和在列表上按是同一件事。</div>");
      }
      if (st.s === "bad") {
        body.push('<div class="vhint">' + esc(ev[st.ei].note) + "</div>");
      }
      var a = loopAt[i];
      if (a && st.s !== "pending") {
        body.push('<div class="looptag">↺ <b>第 ' + (a.round + 1) + " 轮</b>（上限 " + a.max +
          "）· 上一轮在「" + esc(K[steps[a.from].kind].title(steps[a.from].p)) + "」没过</div>");
      }

      h.push('<li class="vst" data-s="' + st.s + '" data-lit="' + (st.s === "done") + '">' +
        '<span class="pin"><b>' + (st.s === "done" ? "✓" : st.s === "bad" ? "!" : i + 1) + "</b></span>" +
        '<div class="vb">' + body.join("") + "</div></li>");
    });
    el.rail.innerHTML = h.join("");

    // 回拐的括号：量出两个站点圆心的位置再画，天生和站台对齐
    var lis = el.rail.children;
    f.arcs.forEach(function (a) {
      var top = lis[a.to].offsetTop + 8, bot = lis[a.from].offsetTop + 8;
      var d = document.createElement("div");
      d.className = "loopbar";
      d.style.top = top + "px";
      d.style.height = Math.max(bot - top, 10) + "px";
      el.rail.appendChild(d);
    });
  }

  function tlHtml(f) {
    var upto = Math.min(t, ev.length - 1), h = [];
    for (var i = 0; i <= upto; i++) {
      var e = ev[i];
      h.push('<div class="ev" data-tone="' + e.tone + '" data-cur="' + (i === upto && !f.over) + '">' +
        '<span class="t">' + hhmm(e.at).slice(0, 5) + '</span><span class="d"></span>' +
        '<span class="x"><b>' + esc(e.label) + "</b> · " + esc(e.status) + "</span></div>");
    }
    if (f.over) {
      h.push('<div class="ev end" data-tone="' + end.tone + '"><span class="t">' +
        hhmm(ev.tot).slice(0, 5) + '</span><span class="d"></span><span class="x"><b>' +
        esc(end.text) + "</b></span></div>");
    }
    el.tl.innerHTML = h.join("");
    el.tl.scrollTop = el.tl.scrollHeight;
  }

  // ── 左边会话区：只做示意，让人看清「线在边上、会话在中间」 ─────────
  function mainHtml(f) {
    var h = ['<div class="msg" data-me="true"><span class="mt">14:02</span>' +
      "把设置页的「工作流」入口做出来：进去能看到本项目当前这条线，能改，能存成项目默认。</div>"];
    var got = function (kind, st) {
      return steps.some(function (s) { return s.kind === kind && f.map[s.id].s === st; });
    };
    if (got("run", "done") || got("verify", "done") || got("verify", "bad")) {
      h.push('<div class="msg"><span class="mt">codex@cpa · 14:05</span>' +
        "改完了，新增 <b>SettingsWorkflow.tsx</b>，接上 <b>useWorkflowDraft</b>。" +
        "<pre>web/src/settings/SettingsWorkflow.tsx  +214\nweb/src/lib/workflow.ts               +86</pre></div>");
    }
    if (got("verify", "bad")) {
      h.push('<div class="msg"><span class="mt">codex@review · 14:09</span>' +
        "typecheck 没过：<b>workflow.ts:42</b> 少一个 <b>fail</b> 字段。已按这一关配的规矩打回第 1 站。</div>");
    }
    if (got("preview", "done")) {
      h.push('<div class="msg"><span class="mt">系统 · 14:12</span>' +
        "预览已起：<b>http://127.0.0.1:14003</b>（下一个人工关口结束时回收）</div>");
    }
    if (got("human", "wait")) {
      h.push('<div class="msg"><span class="mt">系统 · 14:12</span>' +
        "停在人工关口，等你点头。右边那一站底下就是「通过 / 打回」。</div>");
    }
    el.mbody.innerHTML = h.join("");
    el.mbody.scrollTop = el.mbody.scrollHeight;
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
    var h = ['<div class="row" data-live="true">' +
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
    railHtml(f); tlHtml(f); listHtml(f); mainHtml(f);
    var w = stateOf(f);
    el.badge.setAttribute("data-tone", w.tone);
    el.badge.textContent = w.text;
    var doneN = steps.filter(function (s) { return f.map[s.id].s === "done"; }).length;
    el.vtitle.textContent = "走到哪了 · " + doneN + "/" + steps.length;
    el.ifrom.innerHTML = "前端真实验收 <em>· 跟随本项目 ash</em>";
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
  el.rew.addEventListener("click", function () { t = 0; manual = {}; build(); stop(); });
  el.scrub.addEventListener("input", function () { t = Number(el.scrub.value); stop(); });
  el.hard.addEventListener("change", function () { t = 0; manual = {}; build(); stop(); });

  // 站台底下那两个按钮是真的：按下去等于给这一关一个结论，后面的推演随之改写
  el.rail.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var f = frame(), l = f.last;
    if (!l || f.map[l.id].s !== "wait") return;
    if (b.dataset.act === "rej") manual[l.id] = "once"; else delete manual[l.id];
    build();
    t++;
    stop();
  });

  // 想把 demo 定格在某一刻（截图、发给别人看）：地址栏加 #t=7，加 #hard 顺带打开那个开关
  if (/(?:^|#|&)hard\b/.test(location.hash)) el.hard.checked = true;
  build();
  var at = /(?:^|#|&)t=(\d+)/.exec(location.hash);
  if (at) t = Math.min(Number(at[1]), ev.length);
  render();
})();
