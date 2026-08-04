/* 「干完之后」这一节 —— 同一份定义（../ui-demo-workflow-kit/model.js）的第三个尺寸：
   收起来是一排站名，展开是线路图。参数一律藏进「点了哪一站才出现」的微菜单里，
   所以它在新建任务面板里只占三行。 */
(function () {
  "use strict";

  var esc = WF.esc, K = WF.KINDS, S = WF.state;
  var el = {
    rail: document.getElementById("rail"), cost: document.getElementById("cost"),
    fork: document.getElementById("fork"), src: document.getElementById("src"),
    grow: document.getElementById("grow"), pop: document.getElementById("pop"),
    ftline: document.getElementById("ftline"), tog: document.getElementById("tog"),
  };

  var open = false;          // 展开编排
  var own = false;           // 这个任务是否已经分出自己的一份
  var pop = null;            // 当前微菜单
  var active = null;         // 高亮哪一站

  WF.loadTemplate("frontend");
  var BASE = snapshot();     // 本项目的默认，用来「还原」和比对

  function snapshot() { return JSON.parse(JSON.stringify({ ws: S.workspace, steps: S.steps })); }
  function restore(sn) {
    S.workspace = sn.ws;
    S.steps = JSON.parse(JSON.stringify(sn.steps));
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function failText(s) {
    var f = s.fail;
    if (!f) return null;
    if (f.mode === "stop") return "没过 → 停下等人";
    if (f.mode === "ask") return "没过 → 问我一句";
    return "没过 → 回第 " + (WF.indexOf(f.backTo) + 1) + " 站，最多 " + f.max + " 轮";
  }

  function render() {
    var h = [];
    S.steps.forEach(function (s, i) {
      if (i) h.push(gap(i));
      h.push(col(s, i));
    });
    h.push(gap(S.steps.length));
    el.rail.innerHTML = h.join("");
    el.rail.setAttribute("data-open", String(open));
    el.grow.textContent = open ? "收起" : "展开编排";
    renderSrc();
    renderCost();
    el.tog.setAttribute("data-on", String(S.workspace === "isolated"));
    el.tog.querySelector("b").textContent =
      S.workspace === "isolated" ? "独立 worktree" : "直接使用项目目录";
    var first = S.steps[0];
    el.ftline.textContent = first
      ? "创建后任务显示「" + WFSIM.STATUS[first.kind].text + "」"
      : "这条线上还没有站";
  }

  function gap(i) {
    return '<div class="gap"><button data-ins="' + i + '" title="在这儿加一步">＋</button></div>';
  }

  function col(s, i) {
    var k = K[s.kind], st = WFSIM.STATUS[s.kind];
    var h = ['<div class="col" style="--tone:' + k.hue + '">',
      '<button class="stn" data-stn="' + s.id + '" data-on="' + (active === s.id) + '" style="--tone:' + k.hue + '">' +
      '<i class="dot"></i><span class="no">' + pad(i + 1) + "</span>" + esc(k.title(s.p)) + "</button>",
      '<div class="meta">',
      '<div class="st">任务显示 <b>' + esc(st.text) + "</b></div>"];
    k.fields.forEach(function (f) {
      var v = s.p[f.key], warn = f.type === "checks" && !v.length;
      var text = f.type === "checks" ? (v.length ? "验 " + v.length + " 项：" + v.join("、") : "还没选验什么") : v;
      h.push('<button class="chip' + (warn ? " warn" : "") + '" data-edit="' + s.id +
        '" data-field="' + f.key + '" title="' + esc(text) + '">' + esc(text) + "</button>");
    });
    if (s.fail) {
      h.push('<button class="fx" data-edit="' + s.id + '" data-field="fail">' + esc(failText(s)) + "</button>");
    }
    return h.join("") + "</div></div>";
  }

  function renderSrc() {
    el.src.textContent = own ? "这个任务自己定" : "跟随本项目 · harness";
    el.src.setAttribute("data-own", String(own));
    if (!own) return el.fork.setAttribute("hidden", "");
    el.fork.removeAttribute("hidden");
    el.fork.innerHTML = "<b>只影响这一个任务</b><span>本项目的默认没被动过</span>" +
      '<span class="sp"></span><button data-save="proj">存成本项目以后的默认</button>' +
      '<button data-save="reset">还原成本项目的</button>';
  }

  function renderCost() {
    var ok = WFSIM.run(S.steps, {});
    var bad = WFSIM.worst(S.steps);
    var r = WF.compile();
    var h = ["<span>顺利走完 <b>" + ok.stats.steps + "</b> 步</span>",
      "<span>·</span><span>要你出面 <b>" + (ok.stats.gates + ok.stats.asks) + "</b> 次</span>",
      "<span>·</span><span>不顺利最多起 <b>" + bad.aiRuns + "</b> 次 AI</span>"];
    r.rows.forEach(function (row) {
      if (row[0] === "ok") return;
      h.push('<span class="' + (row[0] === "deny" ? "bad" : "warn") + '">· ' + esc(row[1]) + "</span>");
    });
    el.cost.innerHTML = h.join("");
  }

  function edit(fn) { fn(); own = true; render(); }

  // ── 微菜单 ──────────────────────────────────────────────────────────
  function closePop() { pop = null; active = null; el.pop.setAttribute("hidden", ""); el.pop.innerHTML = ""; render(); }

  // 锚点存选择器不存节点：每改一下都会重渲染，原来那个按钮已经不在文档里了
  function selOf(t) {
    var d = t.dataset;
    if (d.ins !== undefined) return '[data-ins="' + d.ins + '"]';
    if (d.stn !== undefined) return '[data-stn="' + d.stn + '"]';
    if (d.edit !== undefined) return '[data-edit="' + d.edit + '"][data-field="' + d.field + '"]';
    if (t.id) return "#" + t.id;
    return null;
  }
  function openPop(t, data) {
    pop = { anchor: t, sel: selOf(t) };
    Object.keys(data).forEach(function (k) { pop[k] = data[k]; });
    render(); drawPop();
  }
  function drawPop() {
    if (!pop) return;
    var html = pop.kind === "add" ? addHtml()
      : pop.kind === "stn" ? stnHtml()
      : pop.kind === "fail" ? failHtml()
      : pop.kind === "src" ? srcHtml()
      : fieldHtml();
    if (html == null) return closePop();
    el.pop.removeAttribute("hidden");
    el.pop.innerHTML = html;
    var at = (pop.sel && document.querySelector(pop.sel)) || pop.anchor;
    if (!at) return closePop();
    var r = at.getBoundingClientRect(), w = el.pop.offsetWidth, h = el.pop.offsetHeight;
    var x = Math.max(12, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 12));
    var y = r.bottom + 6 + h > innerHeight - 12 ? Math.max(12, r.top - 6 - h) : r.bottom + 6;
    el.pop.style.left = x + "px"; el.pop.style.top = y + "px";
  }
  function head(text, back) {
    return "<h3>" + (back ? '<button class="back" data-back="1">‹ 返回</button>' : "") + esc(text) + "</h3>";
  }

  function addHtml() {
    return head("在这儿加一步") + Object.keys(K).map(function (kind) {
      var k = K[kind];
      return '<button class="opt" data-add="' + kind + '" style="--tone:' + k.hue + '">' +
        '<span class="d"></span>' + esc(k.label) +
        '<span class="sub">' + esc(WFSIM.STATUS[kind].text) + "</span></button>";
    }).join("");
  }

  function stnHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var k = K[s.kind], i = WF.indexOf(s.id);
    var h = [head("第 " + (i + 1) + " 站 · " + k.label),
      '<div class="tip">这一步跑的时候，任务显示「' + esc(WFSIM.STATUS[s.kind].text) + "」。</div>"];
    k.fields.forEach(function (f) {
      var v = s.p[f.key];
      var text = f.type === "checks" ? (v.length ? v.join("、") : "还没选") : v;
      h.push('<button class="cell" data-drill="' + f.key + '" data-id="' + s.id + '">' +
        esc(f.label) + "<b>" + esc(text) + "</b></button>");
    });
    if (s.fail) {
      h.push('<button class="cell" data-drill="fail" data-id="' + s.id + '">没过怎么办<b>' +
        esc(failText(s).replace("没过 → ", "")) + "</b></button>");
    }
    h.push('<div class="rule"></div><div class="ops">' +
      '<button data-op="left" data-id="' + s.id + '"' + (i ? "" : " disabled") + '>← 往前</button>' +
      '<button data-op="right" data-id="' + s.id + '"' + (i < S.steps.length - 1 ? "" : " disabled") + '>往后 →</button>' +
      '<button class="del" data-op="del" data-id="' + s.id + '">删掉</button></div>');
    return h.join("");
  }

  function fieldHtml() {
    var s = WF.get(pop.stepId);
    if (!s) return null;
    var f = null;
    K[s.kind].fields.forEach(function (x) { if (x.key === pop.field) f = x; });
    if (!f) return null;
    var v = s.p[f.key], h = [head(f.label, pop.back)];
    f.options.forEach(function (o) {
      var on = f.type === "checks" ? v.indexOf(o) >= 0 : o === v;
      h.push('<button class="opt" data-' + (f.type === "checks" ? "check" : "set") +
        '="' + esc(o) + '" data-key="' + f.key + '" data-id="' + s.id + '" data-on="' + on + '">' +
        "<i>✓</i>" + esc(o) + "</button>");
    });
    if (f.type === "checks") h.push('<div class="tip">全过才算这一站通过。</div>');
    return h.join("");
  }

  function failHtml() {
    var s = WF.get(pop.stepId);
    if (!s || !s.fail) return null;
    var f = s.fail, i = WF.indexOf(s.id), h = [head("这一站没过，往哪走", pop.back)];
    WF.FAIL_MODES.forEach(function (m) {
      h.push('<button class="opt" data-fail="mode" data-id="' + s.id + '" data-val="' + m[0] +
        '" data-on="' + (f.mode === m[0]) + '"><i>✓</i>' + esc(m[1]) + "</button>");
    });
    if (f.mode === "back") {
      h.push('<div class="rule"></div>');
      if (!i) h.push('<div class="tip">前面没有站可回 —— 这条会被拦下。</div>');
      S.steps.slice(0, i).forEach(function (t, j) {
        h.push('<button class="opt" data-fail="backTo" data-id="' + s.id + '" data-val="' + t.id +
          '" data-on="' + (t.id === f.backTo) + '"><i>✓</i>回第 ' + (j + 1) + " 站 · " + esc(K[t.kind].label) + "</button>");
      });
      h.push('<div class="ops">' + [1, 2, 3].map(function (n) {
        return '<button data-fail="max" data-id="' + s.id + '" data-val="' + n + '"' +
          (f.max === n ? ' style="background:var(--sel);color:var(--ink)"' : "") + ">最多 " + n + " 轮</button>";
      }).join("") + "</div>");
    }
    return h.join("");
  }

  var SRC = [
    ["sys", "跟随系统默认", "所有项目的兜底那份"],
    ["proj", "跟随本项目 · harness", "这个仓库现在的那份"],
    ["own", "这个任务自己定", "只影响 这一个任务"],
  ];
  function srcHtml() {
    var cur = own ? "own" : "proj";
    return head("这条线从哪来") + SRC.map(function (r) {
      return '<button class="opt" data-src="' + r[0] + '" data-on="' + (r[0] === cur) + '"><i>✓</i>' +
        esc(r[1]) + '<span class="sub">' + esc(r[2]) + "</span></button>";
    }).join("") + '<div class="tip">动了任何一处，它都会自动变成「这个任务自己定」。</div>';
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-ins],[data-stn],[data-edit],[data-add],[data-op],[data-drill]," +
      "[data-set],[data-check],[data-fail],[data-back],[data-src],[data-save],#grow,#src,#tog");
    if (!t) { if (!el.pop.contains(e.target)) closePop(); return; }
    var d = t.dataset;

    if (t === el.grow) { open = !open; closePop(); return; }
    if (t === el.tog) { edit(function () { S.workspace = S.workspace === "isolated" ? "shared" : "isolated"; }); return; }
    if (t === el.src) { return openPop(t, { kind: "src" }); }

    if (d.src !== undefined) {
      if (d.src === "own") own = true;
      else { restore(BASE); own = false; }
      closePop(); return;
    }
    if (d.save !== undefined) {
      if (d.save === "proj") BASE = snapshot();
      else restore(BASE);
      own = false; closePop(); return;
    }

    if (d.ins !== undefined) return openPop(t, { kind: "add", at: Number(d.ins) });
    if (d.stn !== undefined) {
      if (pop && pop.kind === "stn" && pop.stepId === d.stn) return closePop();
      active = d.stn;
      return openPop(t, { kind: "stn", stepId: d.stn });
    }
    if (d.edit !== undefined) {                     // 展开态直接点参数：跳过一层
      active = d.edit;
      return openPop(t, { kind: d.field === "fail" ? "fail" : "field", stepId: d.edit, field: d.field });
    }
    if (d.drill !== undefined) {                    // 从站点菜单里往下钻，钻完能返回
      pop.kind = d.drill === "fail" ? "fail" : "field";
      pop.field = d.drill; pop.back = true;
      return drawPop();
    }
    if (d.back !== undefined) { pop.kind = "stn"; pop.back = false; return drawPop(); }

    if (d.add !== undefined) {
      var at = pop ? pop.at : null, made = null;
      edit(function () { made = WF.insert(d.add, at); });
      if (made) { active = made.id; pop = { anchor: null, sel: '[data-stn="' + made.id + '"]', kind: "stn", stepId: made.id }; render(); drawPop(); }
      return;
    }
    if (d.op !== undefined) {
      edit(function () {
        if (d.op === "del") WF.remove(d.id);
        else WF.move(d.id, d.op === "left" ? -1 : 1);
      });
      if (d.op === "del") return closePop();
      return drawPop();
    }
    if (d.set !== undefined) { edit(function () { WF.get(d.id).p[d.key] = d.set; }); return closePop(); }
    if (d.check !== undefined) {
      edit(function () {
        var arr = WF.get(d.id).p[d.key], i = arr.indexOf(d.check);
        if (i >= 0) arr.splice(i, 1); else arr.push(d.check);
      });
      return drawPop();
    }
    if (d.fail !== undefined) {
      edit(function () {
        var f = WF.get(d.id).fail;
        if (d.fail === "mode") {
          f.mode = d.val;
          if (f.mode === "back" && !f.backTo) {
            var idx = WF.indexOf(d.id), pick = null;
            S.steps.slice(0, idx).forEach(function (s) { if (s.kind === "run") pick = s.id; });
            f.backTo = pick || (idx > 0 ? S.steps[0].id : null);
          }
        }
        if (d.fail === "backTo") f.backTo = d.val;
        if (d.fail === "max") f.max = Number(d.val);
      });
      return drawPop();
    }
  });

  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(); });
  window.addEventListener("resize", closePop);

  render();
})();
