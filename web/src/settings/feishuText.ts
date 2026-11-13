// 飞书分区里「把服务端的枚举翻成人话」的那几张表，和几处时间格式。
//
// 单独放一份是因为同一个状态会在好几张卡上出现（连接卡的状态点、绑定卡里「机器人还没连上」
// 的提醒），文案抄两份迟早一边先漂。
import type { ImApiKind, ImConnectionState, ImQuotaLevel } from "@ash/shared";
import { localeDateTime } from "../lib/localeFormat.ts";

type Tone = "neutral" | "green" | "amber" | "red";

export interface ConnectionView {
  tone: Tone;
  label: string;
  /** 一句话说清这一档意味着什么、该去哪做什么。 */
  detail: string;
}

/**
 * 连接状态 → 状态点颜色 + 名字 + 解释。前五档是「根本没去连」的原因，后五档是长连接
 * 自己的状态，判据见 shared/src/im.ts 的 ImConnectionState。
 */
export function connectionView(state: ImConnectionState, error: string | null, attempts: number): ConnectionView {
  switch (state) {
    case "unconfigured":
      return { tone: "neutral", label: "未配置", detail: "还没填 App ID 和 App Secret，机器人不在线。照下面的开通顺序来。" };
    case "broken":
      return { tone: "red", label: "凭证文件坏了", detail: "库文件旁边那份飞书凭证读不出来，机器人不在线。重新保存一次凭证即可覆盖。" };
    case "preview":
      return { tone: "neutral", label: "预览实例不连接", detail: "这是预览实例，按设计不连飞书——一个飞书应用只能连一个 ash 实例，预览要是也连上，会和正式实例抢事件。" };
    case "not_exclusive":
      return { tone: "amber", label: "同库多实例，不连接", detail: "同一个库正被多个 ash 实例打开。飞书会把每条事件随机交给其中一个，连上就会丢消息，所以都不连。只留一个实例后重启。" };
    case "disabled":
      return { tone: "neutral", label: "已关闭", detail: "推送总开关关着：长连接已断开，机器人下线，飞书里发消息也没人接。" };
    case "idle":
      return { tone: "neutral", label: "未连接", detail: "凭证已就位，还没开始连。可以点「重新连接」。" };
    case "connecting":
      return { tone: "amber", label: "连接中", detail: "正在和飞书建立长连接。" };
    case "connected":
      return { tone: "green", label: "已连接", detail: "长连接正常，飞书里的消息和卡片按钮都会送到这台机器。" };
    case "reconnecting":
      return {
        tone: "amber",
        label: attempts > 0 ? `重连中（第 ${attempts} 次）` : "重连中",
        detail: error ? `上一次断开的原因：${error}` : "长连接断了，正在自动重连。这段时间里点的卡片按钮会丢，连上后再点一次即可。",
      };
    case "failed":
      return {
        tone: "red",
        label: "连接失败",
        detail: error ? `原因：${error}` : "没连上飞书，服务端没给原因。检查 App ID / App Secret 和域名后重新连接。",
      };
  }
}

/** 这几档说明「为什么没去连」，点「重新连接」也不会有用。 */
export const NOT_CONNECTING: readonly ImConnectionState[] = ["unconfigured", "broken", "preview", "not_exclusive", "disabled"];

/** 状态还在变的那几档：轮询要勤一点，「等它变成已连接」才不用干等十秒。 */
export const TRANSIENT_STATES: readonly ImConnectionState[] = ["idle", "connecting", "reconnecting"];

export const QUOTA_LEVELS: readonly { level: ImQuotaLevel; label: string; threshold: string; effect: string }[] = [
  { level: "normal", label: "照常", threshold: "70% 以下", effect: "该推的都推。" },
  { level: "frugal", label: "省着用", threshold: "满 70%", effect: "收到你的消息后不再加「已收到」表情。" },
  {
    level: "essential",
    label: "只推要紧的",
    threshold: "满 90%",
    effect: "只发要你拍板的卡（提问、待验收、失败、驳回、闸口）和对话回复；完成通知不发，在别处处理掉的旧卡片也不再改成「已处理」。",
  },
  { level: "exhausted", label: "见底", threshold: "满 99%", effect: "除了把你刚点的按钮结果写回那张卡，什么都不发。" },
];

export const API_KIND_LABELS: Record<ImApiKind, string> = {
  token: "换取访问令牌",
  send: "发消息 / 发卡片",
  patch: "改卡片",
  reaction: "加表情回执",
  download: "下载图片 / 文件",
  info: "查询机器人与群信息",
};

export const formatTime = (iso: string): string => localeDateTime(iso, "zh-CN");

/** 「3 分钟前」——最近一次收到事件这类时间，人关心的是隔了多久，不是几点几分。 */
export function agoText(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 60_000) return "刚刚";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} 小时前` : formatTime(iso);
}

/** 码还能用多久。不到一分钟时按秒数，免得最后一分钟一直显示「1 分钟」。 */
export function remainingText(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} 秒`;
  return `${Math.ceil(ms / 60_000)} 分钟`;
}

/** 绑定码倒计时，形如 09:41。 */
export function countdownText(expiresAt: string, now: number): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const total = Math.ceil(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const isExpired = (expiresAt: string, now: number): boolean => new Date(expiresAt).getTime() <= now;
