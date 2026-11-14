// 按本地习惯格式化日期和数字，格式器按参数缓存复用，替代直接调 `toLocaleString` 那一族。
//
// 原因在 JavaScriptCore（Safari / mac 版 ash 的 WKWebView）：`Date#toLocaleString`、
// `toLocaleDateString`、`toLocaleTimeString` 每调一次都现建一个 ICU 日期格式器，用完扔给 GC。
// 格式器本体约 30KB，落在系统 malloc 里，GC 却只看得到外面那层 JS 对象 —— 它觉得堆还很小，
// 迟迟不回收，系统 malloc 就一路涨。实测 19020 次调用（317 行的随手记列表渲染 60 遍）把
// 页面进程从 10MB 撑到 600MB；带 locale 参数的数字 `toLocaleString` 每次也有约 2KB。
// 涨到 2GB 上下时 WebKit 的内存压力处理在主线程上遍历几万个 malloc 区域，整页卡死 10～40 秒
// （mac 版随手记「写到一半卡死」就是这个）。Chrome 的 V8 自带缓存，所以只在 WebKit 上发作。
//
// 这里按「参数」缓存格式器，同一组参数全程只建一次。输出与原生那三个方法逐字一致：缺省字段
// 的补法照 ECMA-402 的 ToDateTimeOptions（toLocaleString 补年月日时分秒，Date 版只补年月日，
// Time 版只补时分秒），非法日期照样回 "Invalid Date"。

type DateInput = Date | number | string;
type Locales = string | string[];
type Kind = "any" | "date" | "time";

const DATE_FIELDS = ["weekday", "year", "month", "day", "dateStyle"] as const;
const TIME_FIELDS = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits", "timeStyle"] as const;
const DATE_DEFAULTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" };
const TIME_DEFAULTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "numeric", second: "numeric" };

const dateFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function withDefaults(kind: Kind, options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions {
  const has = (keys: readonly (keyof Intl.DateTimeFormatOptions)[]) => keys.some((key) => options[key] !== undefined);
  const hasDate = has(DATE_FIELDS);
  const hasTime = has(TIME_FIELDS);
  if (kind === "date" ? hasDate || options.timeStyle !== undefined
    : kind === "time" ? hasTime || options.dateStyle !== undefined
      : hasDate || hasTime) return options;
  return {
    ...options,
    ...(kind === "time" ? {} : DATE_DEFAULTS),
    ...(kind === "date" ? {} : TIME_DEFAULTS),
  };
}

function formatDate(kind: Kind, value: DateInput, locales?: Locales, options?: Intl.DateTimeFormatOptions): string {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  if (Number.isNaN(time)) return "Invalid Date";
  const key = `${kind}|${JSON.stringify(locales ?? null)}|${options ? JSON.stringify(options) : ""}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locales, withDefaults(kind, options));
    dateFormats.set(key, format);
  }
  return format.format(time);
}

/** 等同 `new Date(value).toLocaleString(locales, options)`。 */
export const localeDateTime = (value: DateInput, locales?: Locales, options?: Intl.DateTimeFormatOptions) =>
  formatDate("any", value, locales, options);

/** 等同 `new Date(value).toLocaleDateString(locales, options)`。 */
export const localeDate = (value: DateInput, locales?: Locales, options?: Intl.DateTimeFormatOptions) =>
  formatDate("date", value, locales, options);

/** 等同 `new Date(value).toLocaleTimeString(locales, options)`。 */
export const localeTime = (value: DateInput, locales?: Locales, options?: Intl.DateTimeFormatOptions) =>
  formatDate("time", value, locales, options);

/** 等同 `value.toLocaleString(locales, options)`（数字）。 */
export function localeNumber(value: number, locales?: Locales, options?: Intl.NumberFormatOptions): string {
  const key = `${JSON.stringify(locales ?? null)}|${options ? JSON.stringify(options) : ""}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locales, options);
    numberFormats.set(key, format);
  }
  return format.format(value);
}
