/**
 * 原生引导的正文。
 *
 * 给函数 = **惰性**:等打断回执(claude 的 control_response)、投递队列排队、发送前清理都走
 * 完,真正要把字节写出去的那一刻才定稿。浏览器授权这类「用户随时可能在这几秒里改掉」的东西
 * 必须走这条路 —— 固定在等待之前的话,撤销的 PATCH 都已经 200 了,这条还没发出去的消息仍
 * 宣布「本项目已预先授权」(第 8 链第 1 轮审查 P1)。
 *
 * 解析这一步落在**每个 steer 实现自己**身上。类型放宽之后只在 claude 侧解析过,codex 那边照旧把参数
 * 当字符串塞进 JSON —— 函数被 `JSON.stringify` 丢掉,请求少了必填的 `text` 字段,真实 CLI
 * 直接回 `Invalid request: missing field text`,引导会话整条路断掉(第 8 链第 2 轮审查 P1)。
 * 所以类型和解析函数放在同一个文件里:拿了类型就看得到它要配一次 resolve。
 */
export type SteerText = string | (() => string | Promise<string>);

/** 正文定稿:给的是函数就现在调它。调用点必须是**真正发送之前的最后一步**。 */
export async function resolveSteerText(text: SteerText): Promise<string> {
  return typeof text === "function" ? await text() : text;
}
