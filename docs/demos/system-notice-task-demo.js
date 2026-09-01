const data = window.SYSTEM_NOTICE_DEMO_DATA;
const root = document.querySelector('#conversationRows');
const RS = String.fromCharCode(30);

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function formatTime(value) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('month')}/${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

function inlineMarkdown(source) {
  const codes = [];
  let text = escapeHtml(source).replace(/`([^`]+)`/g, (_, code) => {
    const index = codes.push(`<code>${code}</code>`) - 1;
    return `@@CODE${index}@@`;
  });
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="task-link">$1</span>');
  return text.replace(/@@CODE(\d+)@@/g, (_, index) => codes[Number(index)] || '');
}

function renderMarkdown(source) {
  const lines = source.replace(/\r/g, '').split('\n');
  const html = [];
  let index = 0;
  const special = (line) => /^(```|#{1,4}\s|>\s?|[-*]\s|\d+\.\s)/.test(line);

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      index += 1;
      html.push(`<pre class="task-code-block"><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith('>')) quote.push(lines[index++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${quote.map((part) => `<p>${inlineMarkdown(part)}</p>`).join('')}</blockquote>`);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*]\s/.test(lines[index])) items.push(lines[index++].replace(/^[-*]\s/, ''));
      html.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (index < lines.length && /^\d+\.\s/.test(lines[index])) items.push(lines[index++].replace(/^\d+\.\s/, ''));
      html.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !special(lines[index])) paragraph.push(lines[index++].trim());
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }
  return html.join('');
}

function attachmentInfo(text) {
  const marker = '\n\n[用户附带的文件，请用 Read 工具查看以下本地文件]';
  const at = text.indexOf(marker);
  if (at < 0) return { body: text.trim(), count: 0 };
  const tail = text.slice(at + marker.length);
  return { body: text.slice(0, at).trim(), count: (tail.match(/^-/gm) || []).length };
}

function parseTranscript() {
  const rows = [{ kind: 'user', text: data.body, at: data.createdAt }];
  const lines = data.transcript.replace(/\r/g, '').split('\n');
  let buffer = [];
  let toolIndex = 0;

  const flushAgent = (at) => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (!text) return;
    rows.push({ kind: 'agent', text, at, toolCount: data.toolCounts[toolIndex++] || 0 });
  };

  for (const line of lines) {
    if (!line.startsWith(RS)) { buffer.push(line); continue; }
    let marker;
    try { marker = JSON.parse(line.slice(1)); } catch { buffer.push(line); continue; }
    if (marker.t === 'agentEnd') { flushAgent(marker.at); continue; }
    flushAgent(marker.at);
    rows.push({ kind: marker.t, text: marker.text || '', at: marker.at, bySystem: marker.by === 'system', level: marker.level || '' });
  }
  flushAgent(null);
  return rows;
}

function splitAgentText(text) {
  const lines = text.split('\n');
  const conclusion = /^(能做到|审查意见成立|第 2 轮意见成立|你是对的|现在我看懂了|这轮没动代码|做完了|第 1 轮那条|不是时好时坏)/;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (conclusion.test(lines[index].trim())) start = index;
  }
  if (start >= 0) return { process: lines.slice(0, start).join('\n').trim(), conclusion: lines.slice(start).join('\n').trim() };
  if (/^(Now|I'll|Found|Revert)/m.test(text)) return { process: text.trim(), conclusion: '' };
  return { process: '', conclusion: text.trim() };
}

function renderUser(item) {
  const parsed = attachmentInfo(item.text);
  return `<article class="task-message task-message--user"><div class="task-user-bubble"><header><b>你</b><time>${formatTime(item.at)}</time></header><p>${escapeHtml(parsed.body)}</p>${parsed.count ? `<div class="task-attachment">▧ <span>${parsed.count} 张附件</span></div>` : ''}</div></article>`;
}

function renderAgent(item) {
  const parts = splitAgentText(item.text);
  const process = parts.process || (item.toolCount ? '本轮执行过程与工具调用。' : '');
  const fold = process ? `<details class="task-execution-block"><summary><span class="caret">›</span><span>执行过程${item.toolCount ? ` · ${item.toolCount} 个工具` : ''}</span></summary><div class="task-execution-events task-markdown">${renderMarkdown(process)}</div></details>` : '';
  return `<article class="task-message task-message--agent"><span class="task-message-avatar">执</span><div class="task-message-content"><header><b>claude@ccb</b>${item.at ? `<time>${formatTime(item.at)}</time>` : ''}</header>${parts.conclusion ? `<div class="task-markdown">${renderMarkdown(parts.conclusion)}</div>` : ''}${fold}</div></article>`;
}

function reviewSummary(text) {
  if (text.includes('0t1JglZkpG9L/round-1')) return '`awaiting_review` 和团队执行者仍在运行时，会被误判为已经结束。';
  if (text.includes('0t1JglZkpG9L/round-2')) return '任务暂停或等待用户答复时，执行过程仍会提前折叠。';
  if (text.includes('PZzvjCJXWtiy/round-1')) return '任务终态先到、会话结束时间后到时，折叠块会短暂展开后再收起。';
  return '审查发现仍有边界场景不符合预期，需要继续修复。';
}

function reviewRound(text) {
  return text.match(/第\s*(\d+)\s*轮/)?.[1] || '1';
}

function renderReview(item, start) {
  const round = reviewRound(item.text);
  const detail = start ? start.text.replace(/^.*?开始：?\s*/, '') : '逻辑检查';
  return `<section class="system-review-card"><div class="system-review-icon">审</div><div class="system-review-main"><header><b>第 ${round} 轮审查未通过</b><span>${escapeHtml(detail)}</span><time>${formatTime(item.at)}</time></header><h2>${item.text.includes('自动复审已停止') ? '自动复审已停止，等待修复后再决定是否复审' : '审查发现需要继续修复的问题'}</h2><p>${inlineMarkdown(reviewSummary(item.text))}</p><footer><details><summary>查看审查要求</summary><div class="review-raw">${renderMarkdown(item.text)}</div></details><span>已交回原任务，智能体正在修复</span></footer></div></section>`;
}

function renderSystem(item) {
  if (item.text.includes('原工作目录')) {
    return `<div class="system-recovery-row"><span class="system-recovery-icon">↻</span><p><b>工作区已恢复</b>原目录已不存在，系统已重建空工作区；会话与用户消息均已保留。</p><time>${formatTime(item.at)}</time></div>`;
  }
  const text = item.text.replace(/^〔系统〕/, '').trim();
  const tone = item.level === 'notice' ? ' is-notice' : '';
  return `<p class="conversation-note${tone}">${escapeHtml(text)}<time>${formatTime(item.at)}</time></p>`;
}

function renderRows(rows) {
  const html = [];
  let pendingReviewStart = null;
  for (const item of rows) {
    if (item.kind === 'system' && /审查开始/.test(item.text)) { pendingReviewStart = item; continue; }
    if (item.kind === 'user' && item.bySystem && /审查未通过/.test(item.text)) {
      html.push(renderReview(item, pendingReviewStart));
      pendingReviewStart = null;
      continue;
    }
    if (pendingReviewStart) { html.push(renderSystem(pendingReviewStart)); pendingReviewStart = null; }
    if (item.kind === 'user' && !item.bySystem) html.push(renderUser(item));
    else if (item.kind === 'agent') html.push(renderAgent(item));
    else if (item.kind === 'system' || item.bySystem) html.push(renderSystem(item));
  }
  if (pendingReviewStart) html.push(renderSystem(pendingReviewStart));
  return html.join('');
}

root.innerHTML = renderRows(parseTranscript());
