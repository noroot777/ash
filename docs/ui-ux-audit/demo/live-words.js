/* 执行中那一轮说话用的词（live.js 用）：一行执行过程的摘要怎么数、「在想」过多久换一种说法、一段正文怎么拆成能匀速放的小颗。
   全是算字的，不碰页面。对外：ASH.liveWords = { plain, short, summarize, anyBad, thinkWord, atoms }。 */
(() => {
  const plain = (s) => s.replace(/[`*]/g, '');
  const short = (s) => plain(s).replace(/[\w./-]*\/([\w.-]+)/g, '$1');

  /* 「读了 3 个文件，改了 1 个，跑了 1 条命令，等了 2 次哨兵」：读、改按对象去重；相邻两段同一种东西时后一段省掉名词。
     哨兵那半句总在最后、不占前三样的位置——这一轮为什么这么久，多半就在它身上。只挂上、还没等的，说「挂了 N 个哨兵」。
     steps 里没有 verb 的那种（{ bad: '上下文没压成' }）不是它做的事，是中途没成的事：不计数，原话接在最后 */
  const KINDS = [['读', '个', '文件'], ['搜', '次', ''], ['改', '个', '文件'], ['跑', '条', '命令'], ['看网页', '个', '网页'], ['派', '个', '子智能体']];
  const SENTRY = ['挂', '等'];
  function summarize(all) {
    const steps = all.filter((s) => s.verb);
    const bad = all.find((s) => s.bad)?.bad;
    if (!steps.length) return bad ?? '想了一会儿';
    if (steps.length === 1 && !bad) return `${steps[0].verb}了 ${plain(steps[0].text)}`;
    const work = steps.filter((s) => !SENTRY.includes(s.verb));
    const [hung, waits] = SENTRY.map((verb) => steps.filter((s) => s.verb === verb).length);
    const parts = KINDS.map(([verb, unit, noun]) => {
      const mine = work.filter((s) => s.verb === verb);
      return { verb, unit, noun, n: noun === '文件' ? new Set(mine.map((s) => s.text)).size : mine.length };
    }).filter((p) => p.n);
    const rest = parts.slice(3).reduce((sum, p) => sum + p.n, 0) + work.filter((s) => !KINDS.some(([verb]) => verb === s.verb)).length;
    const said = parts.slice(0, 3).map((p, i, all) => `${p.verb}了 ${p.n} ${p.unit}${i && all[i - 1].noun === p.noun ? '' : p.noun}`);
    return [...said, rest && `另有 ${rest} 步`, waits ? `等了 ${waits} 次哨兵` : hung && `挂了 ${hung} 个哨兵`, bad].filter(Boolean).join('，');
  }
  const anyBad = (steps) => steps.some((s) => s.bad);
  const thinkWord = (ms) => (ms >= 45000 ? '想了很久' : ms >= 15000 ? '还在想' : '在想');

  /* 行内的 `代码` 和 **着重** 拆开：代码整颗出，其余一个字一个字放 */
  function atoms(text) {
    const out = [];
    for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (!part) continue;
      if (part.startsWith('`')) out.push({ kind: 'code', s: part.slice(1, -1) });
      else if (part.startsWith('**')) out.push({ kind: 'b', s: part.slice(2, -2) });
      else out.push({ kind: 't', s: part });
    }
    return out;
  }

  ASH.liveWords = { plain, short, summarize, anyBad, thinkWord, atoms };
})();
