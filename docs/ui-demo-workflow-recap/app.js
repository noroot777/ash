/* 照着刚跑完的那次改 —— 编排的入口不是设置页，是任务详情里那条已经跑过的时间线。
   用户在具体的位置说一句「以后这儿要…」，攒出来的就是工作流。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;

  // 这一趟真实跑过的样子（demo 里写死，真实产品里来自任务的事件流）
  var PAST = [
    { kind: "run", t: "09:41", dur: "8 分 12 秒", res: "干完了" },
    { kind: "verify", t: "09:49", dur: "1 分 04 秒", res: "通过" },
    { kind: "human", t: "09:50", dur: "等了 3 小时 02 分", res: "你点了通过" },
    { kind: "accept", t: "12:52", dur: "6 秒", res: "已验收" },
  ];

  // 加一步的菜单说的是「要求」，不是「步骤类型」——用户心里想的是前者
  var ASKS = [
    { kind: "preview", label: "先把预览起起来，我要点开看", sub: "分配端口，日志出现 ready 才算起来" },
    { kind: "verify", label: "让另一个 AI 先复查一遍", sub: "构建 / 测试 / 浏览器点检，勾哪几项都行" },
    { kind: "human", label: "先停下来等我点头", sub: "任务落「需你处理」并推送通知" },
    { kind: "command", label: "跑一条我指定的命令", sub: "非 0 退出码算没过" },
    { kind: "run", label: "再让 AI 干一轮", sub: "换个执行器、或者换个说法重做" },
  ];

  var tl = document.getElementById("tl");
  var saveBox = document.getElementById("save");
  var popBox = document.getElementById("pop");
  var pop = null, saved = null;

  // ── 生成「刚才那一趟」 ───────────────────────────────────────────────
  PAST.forEach(function (row) {
    var s = WF.insert(row.kind);
    s.past = row;
  });
  S.steps.forEach(function (s) {                 // 那一趟里验证没过是回第一步重来的
    if (s.kind === "verify") s.fail = { mode: "back", backTo: S.steps[0].id, max: 2 };
  });

  // 跑起来的时候「关掉的步骤」不算数：编译闸和预演都只看还开着的那些
  function withLive(fn) {
    var all = S.steps;
    S.steps = all.filter(function (s) { return !s.off; });
    try { return fn(); } finally { S.steps = all; }
  }
  function live() { return S.steps.filter(function (s) { return !s.off; }); }
  function dirty() {
    return S.steps.filter(function (s) { return !s.past || s.off || s.tweaked; }).length;
  }

  // ── 时间线 ──────────────────────────────────────────────────────────
  function failText(s) {
    var f = s.fail;
    if (!f) return "";
    if (f.mode === "stop") return "没过就停下等你";
    if (f.mode === "ask") return "没过就问你一句";
    var j = WF.indexOf(f.backTo);
    return "没过就回第 " + (j + 1) + " 步重来，最多 " + f.max + " 轮";
  }

  function render() {
    var h = [];
    S.steps.forEach(function (s, i) {
      h.push(joint(i));
      h.push(ev(s));
    });
    h.push(joint(S.steps.length));
    tl.innerHTML = h.join("");
    renderSave();
  }

  function joint(i) {
    return '<div class="joint"><button data-ins="' + i + '"><span>＋</span>以后这儿加一步</button></div>';
  }

  function ev(s) {
    var k = K[s.kind], st = WFSIM.STATUS[s.kind], p = s.past;
    var cls = "ev" + (p ? "" : " future") + (s.off ? " off" : "");
    var meta = p
      ? k.summary(s.p) + " · " + p.dur
      : "任务会显示「" + st.text + "」 · " + k.summary(s.p);
    return '<div class="' + cls + '" style="--tone:' + k.hue + '">' +
      '<span class="tm">' + esc(p ? p.t : "以后") + "</span>" +
      '<span class="node"></span>' +
      '<div class="txt"><b>' + esc(k.title(s.p)) + "</b>" +
      '<span class="meta">' + esc(meta) + (s.fail && (s.tweaked || !p) ? " · " + esc(failText(s)) : "") + "</span></div>" +
      '<span class="res">' + esc(s.off ? "以后跳过" : p ? p.res : "新加的") + "</span>" +
      '<button class="more" data-more="' + s.id + '" title="以后这一步…">⋯</button></div>';
  }

  // ── 存到哪 ──────────────────────────────────────────────────────────
  var SCOPES = [
    ["task", "只这个任务", "只影响 #Sh2BRa8d 自己重跑"],
    ["proj", "本项目 · ash", "以后这个仓库里新建的任务都这么跑"],
    ["sys", "所有项目", "没自己设过的项目都跟着变"],
  ];

  function renderSave() {
    var n = dirty();
    if (!n && !saved) { saveBox.setAttribute("hidden", ""); saveBox.innerHTML = ""; return; }
    saveBox.removeAttribute("hidden");

    var r = withLive(function () { return WF.compile(); });
    var ok = withLive(function () { return WFSIM.run(S.steps, {}); });
    var chips = live().map(function (s) {
      return '<span class="c" style="--tone:' + K[s.kind].hue + '">' + esc(K[s.kind].label) + "</span>";
    }).join('<span class="ar">→</span>');

    var h = ['<div class="save-in">'];
    h.push('<div class="ln"><span class="tag">以后这么跑</span><span class="chips">' + chips + "</span>" +
      '<span class="cost">顺利的话 ' + ok.stats.steps + " 步 · 要你出面 " +
      (ok.stats.gates + ok.stats.asks) + " 次</span></div>");

    r.rows.forEach(function (row) {
      if (row[0] === "ok") return;
      h.push('<div class="g ' + row[0] + '"><em>' + (row[0] === "deny" ? "存不了" : "提醒") + "</em>" + esc(row[1]) + "</div>");
    });

    if (saved) {
      var sc = SCOPES.filter(function (x) { return x[0] === saved; })[0];
      h.push('<div class="done"><b>已存成「' + esc(sc[1]) + '」</b><span>' + esc(sc[2]) +
        '</span><button data-again="1">再改改</button></div>');
    } else {
      h.push('<div class="ask"><span class="q">改了 ' + n + " 处 · 这条规矩存到哪？</span>");
      SCOPES.forEach(function (x) {
        h.push('<button class="sc" data-save="' + x[0] + '"' + (r.denied ? " disabled" : "") + '><b>' +
          esc(x[1]) + "</b><em>" + esc(x[2]) + "</em></button>");
      });
      h.push('<button class="undo" data-undo="1">算了，还原</button></div>');
    }
    saveBox.innerHTML = h.join("") + "</div>";
  }

  // ── 弹层：两级，进得去也退得回 ───────────────────────────────────────
  function closePop() { pop = null; popBox.setAttribute("hidden", ""); popBox.innerHTML = ""; }
  // 锚点存选择器而不是节点：每次改动都会重渲染时间线，原来那个按钮已经不在文档里了
  function selOf(el) {
    var d = el.dataset;
    if (d.ins !== undefined) return '[data-ins="' + d.ins + '"]';
    if (d.more !== undefined) return '[data-more="' + d.more + '"]';
    return null;
  }
  function anchorEl() { return (pop.sel && document.querySelector(pop.sel)) || pop.anchor; }
  function drawPop() {
    if (!pop) return;
    var html = pop.kind === "ins" ? insHtml() : pop.kind === "field" ? fieldHtml() : rowHtml();
    if (html == null) return closePop();
    popBox.removeAttribute("hidden");
    popBox.innerHTML = '<div class="inner">' + html + "</div>";
    var el = anchorEl();
    if (!el) return closePop();
    var a = el.getBoundingClientRect(), w = popBox.offsetWidth, hh = popBox.offsetHeight;
    var x = Math.max(12, Math.min(a.left + a.width / 2 - w / 2, innerWidth - w - 12));
    var y = a.bottom + 8 + hh > innerHeight - 12 ? Math.max(12, a.top - 8 - hh) : a.bottom + 8;
    popBox.style.left = x + "px"; popBox.style.top = y + "px";
  }

  function insHtml() {
    return "<h3>以后跑到这儿，先…</h3>" + ASKS.map(function (a) {
      return '<button class="opt" data-add="' + a.kind + '" style="--tone:' + K[a.kind].hue + '">' +
        '<i class="d"></i><span class="tx"><b>' + esc(a.label) + "</b><em>" + esc(a.sub) + "</em></span></button>";
    }).join("");
  }

  function rowHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var k = K[s.kind], h = ["<h3>以后这一步…</h3>"];
    h.push('<button class="opt line" data-off="' + s.id + '"><i>' + (s.off ? "↺" : "⤫") + "</i>" +
      (s.off ? "别跳了，还是要跑" : "别跑了，直接跳过") + "</button>");
    if (s.fail) {
      var back = s.fail.mode === "back";
      h.push('<button class="opt line" data-retry="' + s.id + '"><i>' + (back ? "✓" : "↻") + "</i>" +
        (back ? "没过就自己重来（已开）" : "没过就自己重来，最多 2 轮") + "</button>");
    }
    h.push('<div class="sub">或者换个细节</div>');
    k.fields.forEach(function (f) {
      var v = s.p[f.key], txt = f.type === "checks" ? (v.length ? v.join("、") : "还没选") : v;
      h.push('<button class="opt line dive" data-field="' + f.key + '" data-id="' + s.id + '">' +
        "<i>›</i><span class=\"tx\"><b>" + esc(f.label) + "</b><em>" + esc(txt) + "</em></span></button>");
    });
    return h.join("");
  }

  function fieldHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var f = null;
    K[s.kind].fields.forEach(function (x) { if (x.key === pop.field) f = x; });
    if (!f) return null;
    var v = s.p[f.key];
    var h = ['<button class="back" data-back="1">‹ 回上一层</button><h3>' + esc(f.label) + "</h3>"];
    f.options.forEach(function (o) {
      var on = f.type === "checks" ? v.indexOf(o) >= 0 : o === v;
      h.push('<button class="opt line" data-' + (f.type === "checks" ? "check" : "set") + '="' + esc(o) +
        '" data-key="' + f.key + '" data-id="' + s.id + '" data-on="' + on + '"><i>✓</i>' + esc(o) + "</button>");
    });
    if (f.type === "checks") h.push('<div class="ft"><span>全过才算通过</span><button data-close="1">好了</button></div>');
    return h.join("");
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-ins],[data-add],[data-more],[data-off],[data-retry],[data-field]," +
      "[data-set],[data-check],[data-back],[data-close],[data-save],[data-undo],[data-again]");
    if (!t) { if (!popBox.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (d.close) return closePop();
    if (d.ins !== undefined) { pop = { kind: "ins", anchor: t, sel: selOf(t), at: Number(d.ins) }; return drawPop(); }
    if (d.more) {
      var same = pop && pop.kind === "row" && pop.stepId === d.more;
      if (same) return closePop();
      pop = { kind: "row", anchor: t, sel: selOf(t), stepId: d.more };
      return drawPop();
    }
    if (d.back) { pop.kind = "row"; return drawPop(); }

    if (d.add) {
      var at = pop ? pop.at : null;
      closePop();
      var made = WF.insert(d.add, at);
      if (made.kind === "verify") made.fail = { mode: "back", backTo: S.steps[0].id, max: 2 };
      saved = null; render();
      flash(made.id);
      return;
    }
    if (d.off) {
      var s1 = WF.get(d.off); s1.off = !s1.off;
      saved = null; closePop(); render(); return;
    }
    if (d.retry) {
      var s2 = WF.get(d.retry);
      s2.fail = s2.fail.mode === "back"
        ? { mode: "stop", backTo: null, max: 2 }
        : { mode: "back", backTo: S.steps[0].id, max: 2 };
      s2.tweaked = true; saved = null; render(); drawPop(); return;
    }
    if (d.field) { pop.kind = "field"; pop.field = d.field; pop.stepId = d.id; return drawPop(); }
    if (d.set !== undefined) {
      var s3 = WF.get(d.id); s3.p[d.key] = d.set; s3.tweaked = true;
      saved = null; pop.kind = "row"; render(); drawPop(); return;
    }
    if (d.check !== undefined) {
      var s4 = WF.get(d.id), arr = s4.p[d.key], i = arr.indexOf(d.check);
      if (i >= 0) arr.splice(i, 1); else arr.push(d.check);
      s4.tweaked = true; saved = null; render(); drawPop(); return;
    }
    if (d.save) { saved = d.save; closePop(); renderSave(); return; }
    if (d.again) { saved = null; renderSave(); return; }
    if (d.undo) {
      S.steps = S.steps.filter(function (s) { return !!s.past; });
      S.steps.forEach(function (s) {
        s.off = false; s.tweaked = false;
        if (s.kind === "verify") s.fail = { mode: "back", backTo: S.steps[0].id, max: 2 };
      });
      saved = null; closePop(); render();
    }
  });

  function flash(id) {
    var btn = tl.querySelector('[data-more="' + id + '"]');
    if (!btn) return;
    var row = btn.parentNode;
    row.classList.add("fresh");
    setTimeout(function () { row.classList.remove("fresh"); }, 1000);
  }

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", closePop);

  render();
})();
