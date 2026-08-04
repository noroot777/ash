/* 跑一趟 —— 把 WFSIM 推演出的事件按时间演一遍：
   车沿线滑到那一站、站台亮起、行车记录添一行。失败往回拐时车顺着支线倒回去。 */
(function (global) {
  "use strict";

  var esc = WF.esc, S = WF.state;
  var logBox = document.getElementById("log");
  var timer = null, seq = [], at = 0, onDone = null;

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null; seq = []; at = 0;
    var car = document.getElementById("car");
    if (car) car.setAttribute("hidden", "");
    lit(null);
    document.body.classList.remove("riding");
    if (onDone) { var f = onDone; onDone = null; f(); }
  }
  function riding() { return !!timer; }

  function lit(id) {
    WFMAP.rail.querySelectorAll("[data-stn]").forEach(function (el) {
      el.classList.toggle("lit", !!id && el.dataset.stn === id);
    });
  }

  function moveCar(id, cls, text) {
    var car = document.getElementById("car"), c = WFMAP.center(id);
    if (!car || !c) return;
    car.removeAttribute("hidden");
    car.className = "car " + cls;
    car.querySelector("b").textContent = text;
    car.style.transform = "translate(" + (c.x - 10) + "px," + (c.y - 10) + "px)";
  }

  // ── 行车记录 ────────────────────────────────────────────────────────
  function row(e) {
    if (e.jump != null) {
      return '<div class="ev loop"><span class="ord">↩</span><b>' + esc(e.label) +
        '</b><span class="why">' + esc(e.note) + "</span></div>";
    }
    var cls = e.fail ? "bad" : e.tone;
    return '<div class="ev ' + cls + '"><span class="ord">' + WFMAP.pad(e.idx + 1) +
      '</span><b>' + esc(e.status) + "</b>" +
      '<span class="who">' + esc(e.label) + (e.round > 1 ? " · 第 " + e.round + " 轮" : "") + "</span>" +
      '<span class="why">' + esc(e.note) + "</span></div>";
  }

  function start(mode, done) {
    onDone = null;                       // 换一趟车不该触发上一趟的收尾
    stop();
    onDone = done || null;
    var assume = mode === "bad" ? WFSIM.pessimistic(S.steps, "once") : {};
    var r = WFSIM.run(S.steps, assume);
    seq = r.events; at = 0;

    logBox.removeAttribute("hidden");
    logBox.innerHTML = '<div class="loghd"><span class="dot"></span>' +
      (mode === "bad" ? "不顺利那趟：验证和人工关口头一次都不过" : "顺利那趟：每一关都一次过") +
      '<em>共 ' + r.stats.steps + " 步 · 打扰你 " + (r.stats.gates + r.stats.asks) + " 次 · 起 " +
      r.stats.aiRuns + " 次 AI</em></div><div class=\"evs\" id=\"evs\"></div>";
    document.body.classList.add("riding");

    var evs = document.getElementById("evs");
    var end = r.end;
    (function tick() {
      if (at >= seq.length) {
        evs.insertAdjacentHTML("beforeend", '<div class="ev end ' + end.tone + '">' +
          '<span class="ord">✓</span><b>跑完了</b><span class="why">' + esc(end.text) + "</span></div>");
        evs.scrollTop = evs.scrollHeight;
        timer = setTimeout(function () { stop(); }, 1400);
        return;
      }
      var e = seq[at++];
      evs.insertAdjacentHTML("beforeend", row(e));
      evs.scrollTop = evs.scrollHeight;

      if (e.jump != null) {
        var target = S.steps[e.jump];
        if (target) moveCar(target.id, "loop", "↩");
        lit(target ? target.id : null);
      } else {
        lit(e.id);
        moveCar(e.id, e.fail ? "bad" : e.tone, e.fail ? "✕" : WFMAP.pad(e.idx + 1));
      }
      timer = setTimeout(tick, e.jump != null ? 560 : e.fail ? 620 : 780);
    })();
  }

  // 常驻那行统计：这条流程一直不过会怎样
  function worstLine() {
    if (!S.steps.length) return "";
    var w = WFSIM.worst(S.steps);
    return "检查关口一直不过：最多打扰你 " + w.interrupts + " 次 · 最多起 " + w.aiRuns + " 次 AI";
  }

  global.WFRIDE = { start: start, stop: stop, riding: riding, worstLine: worstLine };
})(window);
