/* 进行条（live.js 用）：就是那一行「执行过程」。进行时字上有流光、后面跟着用时，做完原地落定成过去式；同一时刻只有它或者正在出的正文是「活的」。
   它一共三种说法：在想 / 正在做什么 / 中途插进来的事（在压缩上下文、上游没回话在重试）。等哨兵不在这一行上——那时任务是暂停的（feedKit.wait）。
   对外：ASH.liveStrip({ now, claim, enter, follow }) → { open, relabel, restate, settle, tick }；now() 是正在跑的那一轮（没有就是 null），
   进行条挂在 now().turn.body 的最后、记在 now().strip 上，后面的用时从 now().s0 算起。 */
(() => {
  const { h } = ASH;
  const { summarize, anyBad, thinkWord } = ASH.liveWords;

  ASH.liveStrip = ({ now, claim, enter, follow }) => {
    function open(text, thinking = false) {
      const run = now();
      const strip = ASH.feedKit.fold(text);
      const at = performance.now();
      Object.assign(strip, { time: h('span.live-time.num'), steps: [], thinking, said: text, since: at, shownAt: at, pending: 0 });
      strip.btn.classList.add('is-live');
      strip.label.classList.add('shim');
      strip.label.after(strip.time);
      enter(strip.btn);
      run.turn.body.append(strip.btn, strip.list);
      run.flat.push(strip.btn, strip.list);
      run.strip = strip;
      claim(strip.label, 'run-2');   /* 两条认领在同一处会叠成一颗圆圈：「在想」认字，「跟着工具换标题」认这一行 */
      claim(strip.btn, 'run-3');
      tick();
      follow();
      return strip;
    }
    /* 换标题：每条至少停 1 秒；积压了就只留最新的一条。字换了宽度会变：后面的用时跟着滑过去，换字那一拍它和旧字一起暗下去 */
    function swapLabel(strip, text) {
      ASH.swap(strip.label, text, { row: strip.btn });
      if (ASH.reduced()) return;
      strip.time.classList.add('is-dim');
      setTimeout(() => strip.time.classList.remove('is-dim'), 150);
    }
    function relabel(strip, text) {
      clearTimeout(strip.pending);
      strip.said = text;
      strip.pending = setTimeout(() => { strip.shownAt = performance.now(); swapLabel(strip, text); }, Math.max(0, strip.shownAt + 1000 - performance.now()));
    }
    /* 换一种说法。中途插进来的事后面的用时是「这件事花了多久」，调的人先把 s0 拨到这一刻。
       still = 这会儿没有东西在动（等上游回话）：字上没有流光；thinking = 换回「在想」接着走 */
    function restate(strip, text, { still = false, thinking = false } = {}) {
      clearTimeout(strip.pending);
      strip.thinking = thinking;
      strip.said = text;
      strip.since = strip.shownAt = performance.now();
      strip.label.classList.toggle('shim', !still);
      strip.time.classList.remove('is-in');
      if (strip.label.textContent !== text) swapLabel(strip, text);
    }
    /* 落定是一拍：流光停，旧句和用时按原来的颜色一起淡出；150ms 后同一行换成过去式（或者你给的那句话），
       cls（失败的红）在换字的那一刻才加上，then 里是要和新句一起进场的东西 */
    function settle(strip, text, cls, then) {
      clearTimeout(strip.pending);
      strip.btn.classList.remove('is-live');
      strip.label.classList.remove('shim');
      strip.time.classList.remove('is-in');
      ASH.swap(strip.label, text ?? summarize(strip.steps), { row: strip.btn });
      strip.btn.classList.toggle('has-bad', !text && anyBad(strip.steps));
      const land = () => { strip.time.remove(); if (cls) strip.btn.classList.add(cls); then?.(); };
      if (ASH.reduced()) land(); else setTimeout(land, 150);
      delete strip.btn.dataset.m;
      delete strip.label.dataset.m;
      const run = now();
      if (run?.strip === strip) run.strip = null;
    }
    /* 用时过 2 秒才跟上来；「在想」过 15 秒换一次说法 */
    function tick() {
      const run = now();
      const strip = run?.strip;
      if (!strip) return;
      const at = performance.now();
      if (at - run.s0 >= 2000) { strip.time.textContent = ASH.dur(at - run.s0); strip.time.classList.add('is-in'); }
      if (strip.thinking && thinkWord(at - strip.since) !== strip.said) relabel(strip, thinkWord(at - strip.since));
    }
    return { open, relabel, restate, settle, tick };
  };
})();
