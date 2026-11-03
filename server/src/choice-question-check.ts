// 熔断路径上那道选择题的**硬格式**校验（工具侧，不靠提示词）。
//
// 用户只在「方案该怎么定」时被找，而他对现在收到的驳回/裁定摘要的评价是「每次都看不懂」——
// 那几段字写给的是审查者，满篇文件名、函数名、轮次。熔断把执行者卡在「要么改全、要么问用户」，
// 问的那一下就必须是人话，所以这里按关键词做机械判定：违规就退回、逐条说改什么；合规的一个字
// 都不多花（错误信息只在违规时出现）。
//
// 只做「按关键词判」，**不做语义判**：后果句认的是「会 / 失去 / 代价 …」这类词，不判断那句话
// 说得对不对。判据宁严勿松的方向是对的：被退回只多一次改写，放过一道看不懂的题则是用户要为它
// 回头读一遍代码。
//
// 写成纯函数、不认识任务和熔断状态：要不要对非熔断的 ask_question 也开，是调用点的事。

export type ChoiceQuestion = {
  /** 背景（多问题时是共同引言）。 */
  question: string;
  options: string[];
  items?: Array<{ question: string; options?: string[] }> | null;
};

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_SENTENCES = 2;

/** 用户界面上常见、长得像驼峰的产品名：不算代码标识符。 */
const PRODUCT_WORDS = new Set([
  "macOS", "iOS", "iPadOS", "iPhone", "iPad", "GitHub", "GitLab", "JavaScript", "TypeScript",
  "PowerShell", "WeChat", "YouTube", "ChatGPT", "OpenAI", "DeepSeek", "LinkedIn", "PayPal",
]);

/** 每一类禁入字眼：名字（写进退回说明）+ 怎么认。 */
const FORBIDDEN: Array<{ what: string; find: (text: string) => string | null }> = [
  {
    what: "文件路径",
    find: (text) => /(?:^|[\s(（"'`“「])((?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*|[A-Za-z]:\\[^\s]+)/.exec(text)?.[1]
      ?? /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|kt|swift|css|scss|html|sh|ya?ml|toml|sql|lock)\b/.exec(text)?.[0]
      ?? null,
  },
  {
    // `ash/xxx`、`origin/main`、`feature/foo-bar`：两边都至少两个字符，`A/B` 这种口语不算。
    what: "分支名",
    find: (text) => /\b[A-Za-z0-9_.-]{2,}\/[A-Za-z0-9_./-]{2,}/.exec(text)?.[0] ?? null,
  },
  {
    what: "代码标识符",
    find: (text) => {
      for (const match of text.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) {
        if (!PRODUCT_WORDS.has(match[0])) return match[0];
      }
      return null;
    },
  },
  {
    // 7–40 位十六进制，且字母数字都有（纯数字是数量，纯字母是单词）。
    what: "commit",
    find: (text) => {
      for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
        if (/\d/.test(match[0]) && /[a-f]/i.test(match[0])) return match[0];
      }
      return null;
    },
  },
  {
    what: "「第 N 轮」",
    find: (text) => /第\s*[\d一二三四五六七八九十两]+\s*轮/.exec(text)?.[0] ?? null,
  },
];

/** 「选它你会… / 会失去…」一类后果句：按关键词认。 */
const CONSEQUENCE = /会|将|导致|代价|失去|换来|意味着|后果|好处|坏处|风险|损失|得到|省下|多花|少了|就能|就得/;

/** 句子数：按句末标点与换行切，空段不算。 */
export function sentenceCount(text: string): number {
  return text.split(/[。！？!?]+|\n+|\.(?=\s|$)/).map((part) => part.trim()).filter(Boolean).length;
}

function forbiddenIn(text: string): string[] {
  return FORBIDDEN.flatMap(({ what, find }) => {
    const hit = find(text);
    return hit ? [`${what}「${hit}」`] : [];
  });
}

/**
 * 校验一道选择题。返回**要改的地方**，一条一行；空数组 = 合规。
 *
 * 多问题（`items`）时每个子问题各自是一道选择题，顶层 `question` 当共同背景核。
 */
export function checkChoiceQuestion(input: ChoiceQuestion): string[] {
  const problems: string[] = [];
  const background = (label: string, text: string) => {
    if (sentenceCount(text) > MAX_SENTENCES) {
      problems.push(`${label}有 ${sentenceCount(text)} 句，最多 ${MAX_SENTENCES} 句：只留「要定什么、为什么现在要定」`);
    }
    const hits = forbiddenIn(text);
    if (hits.length) problems.push(`${label}里有${hits.join("、")}：换成用户看得懂的说法`);
  };
  const options = (label: string, list: string[]) => {
    if (list.length < MIN_OPTIONS || list.length > MAX_OPTIONS) {
      problems.push(`${label}有 ${list.length} 个选项，要 ${MIN_OPTIONS}–${MAX_OPTIONS} 个`);
    }
    list.forEach((option, index) => {
      const hits = forbiddenIn(option);
      if (hits.length) problems.push(`${label}第 ${index + 1} 个里有${hits.join("、")}：换成用户看得懂的说法`);
      if (!CONSEQUENCE.test(option)) {
        problems.push(`${label}第 ${index + 1} 个没有后果句：补一句「选它你会…／会失去…」`);
      }
    });
  };
  background("背景", input.question);
  if (input.items?.length) {
    input.items.forEach((item, index) => {
      background(`第 ${index + 1} 个问题`, item.question);
      options(`第 ${index + 1} 个问题的选项`, item.options ?? []);
    });
  } else {
    options("选项", input.options);
  }
  return problems;
}

/** 退回时的那段说明：先说为什么被退，再逐条说改什么。 */
export function choiceQuestionRejection(problems: string[]): string {
  return "这道题要交给用户拍板，必须是没读过代码的人也看得懂的选择题，下面几处改完再提：\n" +
    problems.map((problem) => `- ${problem}`).join("\n");
}
