/* 三段胶囊：执行器 · 模型 · 智能水平。「选谁干活」在全样机只有这一种长相
   （新建面板、团队与讨论的角色、起手式站点、执行模式、助手；回复框那一颗是同样的三段）。
   const t = ASH.target({ value: { agent, model, level } | null, follow, label, place, onchange(value) })
     value 为 null 且给了 follow（如「跟随任务的执行器」）时，胶囊收成一段、写着 follow；点开第一段能选回具体的执行器。
     model / level 为 null = 跟随执行器自己的默认。
   t.el（span.caps）、t.value、t.set(value) */
(() => {
  const { h } = ASH;
  ASH.AGENTS = {
    claude: { models: ['opus-5-5', 'sonnet-5', 'haiku-5'], levels: ['low', 'medium', 'high', 'max'] },
    codex: { models: ['gpt-5.6-sol', 'gpt-5.5'], levels: ['low', 'medium', 'high', 'xhigh'] },
    gemini: { models: ['gemini-3-pro', 'gemini-3-flash'], levels: ['low', 'high'] },
  };

  ASH.target = ({ value = null, follow = null, label = '谁来跑', place = 'bottom-start', onchange } = {}) => {
    let who = value ? { ...value } : null;
    const seg = (tip) => h('button', { type: 'button', 'aria-haspopup': 'listbox', 'data-tip': tip }, h('span'));
    const segs = { agent: seg('执行器'), model: seg('模型'), level: seg('智能水平') };
    const el = h('span.caps', { role: 'group', 'aria-label': label }, segs.agent, segs.model, segs.level);
    const text = () => (who ? { agent: who.agent, model: who.model ?? '跟随执行器', level: who.level ?? '跟随' } : { agent: follow, model: '', level: '' });
    function paint(quick) {
      const now = text();
      el.classList.toggle('is-follow', !who);
      for (const [name, btn] of Object.entries(segs)) {
        btn.hidden = !who && name !== 'agent';
        if (quick || btn.hidden) btn.firstChild.textContent = now[name]; else ASH.swap(btn.firstChild, now[name]);
        btn.setAttribute('aria-label', `${btn.dataset.tip}：${now[name]}`);
      }
    }
    const api = { el, get value() { return who && { ...who }; }, set(next) { who = next ? { ...next } : null; paint(true); } };
    const choose = (btn, options, current, onpick) => ASH.menu(btn, options.map(([key, name]) => ({
      label: name, selected: key === current, onpick: () => { onpick(key); paint(); onchange?.(api.value); btn.focus(); },
    })), { role: 'listbox', place });
    segs.agent.addEventListener('click', () => choose(segs.agent, [...(follow ? [[null, follow]] : []), ...Object.keys(ASH.AGENTS).map((name) => [name, name])], who?.agent ?? null, (name) => {
      if (name === (who?.agent ?? null)) return;
      who = name ? { agent: name, model: null, level: null } : null;   /* 换执行器时后两段回到「跟随」 */
    }));
    segs.model.addEventListener('click', () => choose(segs.model, [[null, '跟随执行器'], ...ASH.AGENTS[who.agent].models.map((name) => [name, name])], who.model, (name) => { who.model = name; }));
    segs.level.addEventListener('click', () => choose(segs.level, [[null, '跟随'], ...ASH.AGENTS[who.agent].levels.map((name) => [name, name])], who.level, (name) => { who.level = name; }));
    paint(true);
    return api;
  };
})();
