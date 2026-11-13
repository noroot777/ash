/**
 * 一条 ⌘K 查询里**要标出来的词**：引号括起来的算一个词，`|` 和空白分词，`-词` 是排除不标。
 * 语法与服务端 tokenize（server/src/search.ts）同一套，这里只取正向词、去重、长的在前 ——
 * 长的先试，「编辑器」和「编辑」同时在时标出来的是整个「编辑器」。
 *
 * 面板里的高亮和打开任务后会话里那一下闪烁共用它：两处标的必须是同一组词。
 */
export function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  let value = "";
  let quoted = false;
  let excluded = false;
  let started = false;
  const flush = () => {
    const term = value.trim();
    if (term && !excluded) terms.push(term);
    value = "";
    excluded = false;
    started = false;
  };
  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    if (quoted) {
      if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') {
      quoted = true;
      started = true;
    } else if (character === "|" || /\s/.test(character)) {
      flush();
    } else if (!started && character === "-" && (index === 0 || /\s/.test(query[index - 1] ?? ""))) {
      excluded = true;
      started = true;
    } else {
      value += character;
      started = true;
    }
  }
  flush();
  return [...new Set(terms)].sort((left, right) => right.length - left.length);
}
