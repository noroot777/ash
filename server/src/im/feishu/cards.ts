// 卡片的语义模型 → 飞书卡片 JSON 2.0。
//
// 只用到 P0 实测过的几样：标题栏、div 纯文本、按钮（回调 / 打开链接 / 原生二次确认）、
// 表单（输入框 + 提交按钮）。所有来自任务的文字一律 plain_text —— 智能体写的 markdown
// 在卡片里不渲染，换来的是谁也没法借一段任务正文往卡片里塞链接、@ 全员或者伪造按钮。
// 深链也只做成按钮（open_url），不出现在正文里。
//
// `config.update_multi`：同一张卡在所有人眼里是同一份，改卡（回调回卡、PATCH）对大家都生效 ——
// 群卡片上一个人点了「放行」，其他人看到的也随之变成「已放行」。

export type CardTone = "orange" | "red" | "purple" | "blue" | "green" | "grey" | "turquoise" | "wathet";

export interface CardButton {
  text: string;
  style?: "primary" | "default" | "danger";
  /** 回调按钮：点下去把这份 value 送回来（信封 id + 动作）。 */
  value?: Record<string, string | number>;
  /** 打开链接的按钮。与 value 二选一。 */
  url?: string;
  /** 飞书客户端原生的二次确认弹窗。 */
  confirm?: { title: string; text: string };
  /** 表单里的提交按钮必须有名字（回调里用它区分点的是哪一个）。 */
  name?: string;
}

export interface CardInput {
  name: string;
  placeholder: string;
  label?: string;
  /** 有选项就是下拉单选（select_static），提交时 form_value 里是选中那一项的 value。 */
  options?: { text: string; value: string }[];
  /** 下拉框默认选中的 value。 */
  initial?: string;
  /** 不填 / 不选不让提交（飞书客户端拦，只在表单里有效）。 */
  required?: boolean;
  /** 飞书的上限就是 1000（2026-11-06 实测：填 4000 整张卡被拒，230099 / 11310），这里只能往小改。 */
  maxLength?: number;
  multiline?: boolean;
}

export type CardBlock =
  | { type: "text"; text: string }
  | { type: "note"; text: string }
  | { type: "buttons"; buttons: CardButton[] }
  | { type: "form"; name: string; inputs: CardInput[]; buttons: CardButton[] }
  | { type: "divider" };

export interface CardModel {
  title: string;
  subtitle?: string;
  tone: CardTone;
  blocks: CardBlock[];
}

const plain = (content: string) => ({ tag: "plain_text", content });
const INPUT_MAX = 1000;

function renderButton(button: CardButton, inForm: boolean): Record<string, unknown> {
  const type = button.style === "primary" ? "primary_filled" : button.style === "danger" ? "danger" : "default";
  const out: Record<string, unknown> = { tag: "button", text: plain(button.text), type, width: "default" };
  if (button.name) out.name = button.name;
  if (inForm) out.form_action_type = "submit";
  if (button.url) out.behaviors = [{ type: "open_url", default_url: button.url }];
  else if (button.value) out.behaviors = [{ type: "callback", value: button.value }];
  if (button.confirm) out.confirm = { title: plain(button.confirm.title), text: plain(button.confirm.text) };
  return out;
}

function buttonRow(buttons: CardButton[], inForm = false): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "flow",
    horizontal_spacing: "8px",
    columns: buttons.map((button) => ({
      tag: "column", width: "auto", elements: [renderButton(button, inForm)],
    })),
  };
}

function renderBlock(block: CardBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { tag: "div", text: { ...plain(block.text), text_size: "normal" } };
    case "note":
      return { tag: "div", text: { ...plain(block.text), text_size: "notation", text_color: "grey" } };
    case "divider":
      return { tag: "hr" };
    case "buttons":
      return buttonRow(block.buttons);
    case "form":
      return {
        tag: "form",
        name: block.name,
        elements: [
          ...block.inputs.map((input) => input.options ? {
            tag: "select_static",
            name: input.name,
            placeholder: plain(input.placeholder),
            width: "fill",
            options: input.options.map((option) => ({ text: plain(option.text), value: option.value })),
            ...(input.initial !== undefined ? { initial_option: input.initial } : {}),
            ...(input.required ? { required: true } : {}),
          } : {
            tag: "input",
            name: input.name,
            placeholder: plain(input.placeholder),
            ...(input.label ? { label: plain(input.label), label_position: "top" } : {}),
            max_length: Math.min(input.maxLength ?? INPUT_MAX, INPUT_MAX),
            ...(input.required ? { required: true } : {}),
            ...(input.multiline ? { input_type: "multiline_text", rows: 3, auto_resize: true, max_rows: 8 } : {}),
          }),
          buttonRow(block.buttons, true),
        ],
      };
  }
}

export function renderCard(model: CardModel): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: plain(model.title),
      ...(model.subtitle ? { subtitle: plain(model.subtitle) } : {}),
      template: model.tone,
    },
    body: { elements: model.blocks.map(renderBlock) },
  };
}
