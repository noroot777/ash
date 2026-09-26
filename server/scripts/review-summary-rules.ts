// 报告摘要契约的**规则清单**。完整 prompt（`REPORT_SUMMARY_FORMAT`）和续跑提醒
// （`REPORT_SUMMARY_REMINDER`）各写各的措辞、各有各的密度，但**规则必须逐条都有**
// ——这张表就是那个「逐条」。
//
// 为什么要有它：两份字符串是手维护的，往完整版加一条规则不会自动出现在缩略版里，而缩略版
// 是断线续跑时唯一跟得到底的那份。2026-09-26 连续三轮审查都在报同一件事（「提醒里又漏了
// N 条」），每轮补两三条、下一轮再被找出剩下的。靠人记是记不住的，所以改成：规则在这里
// 登记一次，`test-review-flow.ts` / `test-review-resume.ts` 拿它比对两边。
//
// 加规则的流程因此是三步：写进 `FORMAT`、写进 `REMINDER`、在这里登记。漏掉第二步，
// `test:review` 和 `test:review-resume` 当场红，并直接报出漏了哪几条。
//
// 正则认的是**这条规则的内核**，不是某一句原话：完整版讲得开（「第一行「你会遇到」：用户
// 会看到什么错的结果」），缩略版挤成一句（「你会遇到只写现象不带机制」），两边都得认。
// 贴措辞贴太死，改个说法就红一次，红久了就没人当回事；放太松则删掉规则也照样过。
// 两边现在用同一条正则；哪天某条规则在两处的说法真的分岔了，再把它拆成两列。
import assert from "node:assert/strict";

export type SummaryRule = {
  /** 出问题时报给人看的名字。 */
  id: string;
  /** 这条规则在文本里的样子，完整版和缩略版都要命中。 */
  pattern: RegExp;
};

export const SUMMARY_RULES: SummaryRule[] = [
  { id: "结论节起头", pattern: /## 结论/ },

  { id: "栏目：能不能验收", pattern: /能不能验收/ },
  { id: "不能验收时点名最要命那条", pattern: /最要命/ },
  { id: "光报个数不算数", pattern: /「有 N 条」不算/ },

  { id: "栏目：现在什么能用了", pattern: /现在什么能用了/ },
  { id: "写界面上看得见的行为", pattern: /界面上[能看得]{2}见的行为/ },
  { id: "没做成时的固定兜底文案", pattern: /没有新增可用的东西/ },

  { id: "栏目：必须修的问题", pattern: /必须修的问题/ },
  { id: "每条问题一个小标题", pattern: /每条(问题)?一个小标题/ },
  { id: "不许把一条塞进另一条里", pattern: /塞进另一条|不许嵌套/ },
  { id: "第一行只写现象、不带机制", pattern: /第一行「你会遇到」|只写现象|只写用户会遇到什么/ },
  { id: "第二行才讲机制", pattern: /第二行「为什么」|为什么讲机制|机制放第二行/ },
  { id: "第三行给修法", pattern: /建议怎么修/ },
  { id: "没问题时的固定文案", pattern: /没有发现问题/ },
  { id: "别拿核对记录当问题清单", pattern: /核对记录/ },
  { id: "摘要最多展开 5 条", pattern: /最多展开 5 条/ },
  { id: "超出的写进明细、一条不丢", pattern: /一条都?不许丢/ },

  { id: "栏目：不拦验收但你该知道的", pattern: /不拦验收/ },
  { id: "不拦项一行一条、不写原因", pattern: /一行一条[，、]不写原因/ },

  { id: "严重度只有两档", pattern: /两档/ },

  // 合规证明逐项钉：曾经只用一条宽泛的或规则代替（`/不进这一节|不许出现基线 hash/`），
  // 结果 `git status` 和浏览器通道降级说明两项从缩略版里掉了、测试照样绿——第 3 轮审查
  // 报的就是这个。一条宽泛断言代替多条契约，等于没断言。
  { id: "摘要禁入：基线 hash", pattern: /基线 hash/ },
  { id: "摘要禁入：git status", pattern: /git status/ },
  { id: "摘要禁入：命令输出", pattern: /命令输出/ },
  { id: "摘要禁入：清场记录", pattern: /清场记录/ },
  { id: "摘要禁入：浏览器通道降级说明", pattern: /浏览器(通道)?降级说明/ },
];

/** 逐条核对一段文本带全了契约规则；缺哪几条就报哪几条的名字。 */
export function assertSummaryRules(text: string, source: string): void {
  const missing = SUMMARY_RULES.filter((rule) => !rule.pattern.test(text)).map((rule) => rule.id);
  assert.deepEqual(missing, [], `${source} 漏了摘要契约规则：${missing.join("、")}`);
}
