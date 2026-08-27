import { useMemo, useState } from "react";
import type { AgentType } from "@ash/shared";
import {
  cliConfigOverrideErrors,
  cliConfigOverridesFor,
  type CliConfigOverride,
} from "@ash/shared/cli-overrides";

/**
 * 「ash 替你写进 CLI 的配置」那几个数的**草稿态**:解析、夹范围、算脏、算错。
 *
 * 抽出来是因为这一档配置有两个入口 —— 设置页执行器行上的 `ProfileOverridesControl`,
 * 和会话尾栏那颗上下文胶囊里的 `ContextCompactQuickSettings`。两处填的是同一个
 * profile 的同一份字段,校验规则一旦分家就会长出「这边存得下、那边存不下」这种
 * 只有用户能发现的差异。判据本体仍在 shared/src/cli-overrides.ts(前后端共用那份),
 * 这里只负责「用户正在敲的这串字符怎么变成能存的数」。
 */

const fmtNumber = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** 带单位的展示形态:百分比原样带 %,token 数缩成 200k。 */
export const fmtOverrideValue = (n: number, unit?: string) => (unit === "%" ? `${n}%` : fmtNumber(n));

/** 「要在 100k–1M 之间」里的那一段。 */
export const fmtOverrideRange = (spec: CliConfigOverride) => `${fmtNumber(spec.min)}–${fmtNumber(spec.max)}`;

/** 一组值的比较用指纹(对象引用不可靠:调用方常写 `value ?? {}`,每次渲染都是新对象)。 */
function fingerprint(specs: CliConfigOverride[], source: Record<string, number>): string {
  return specs.map((spec) => `${spec.key}=${source[spec.key] ?? ""}`).join("&");
}

export interface CliOverrideDraft {
  /** 这类 CLI 声明了哪些可覆盖项;空数组 = 这个入口整个不该渲染。 */
  specs: CliConfigOverride[];
  draft: Record<string, string>;
  set: (key: string, raw: string) => void;
  /** 丢掉草稿,回到已保存的值。 */
  reset: () => void;
  /** 能存下去的那份。空串 = 清掉这一项(回到「跟随 CLI」),不是 0。 */
  parsed: Record<string, number>;
  /** 人话错因;非空时不许保存。 */
  errors: string[];
  dirty: boolean;
  /** 已保存的值里真正配了的那几项。 */
  active: CliConfigOverride[];
}

/**
 * @param editing 用户正在这个入口里编辑(弹层开着)。false 时草稿跟着外部值走 ——
 *   别的表面改了同一个 profile,收起来的那个入口不该还显示旧数。
 */
export function useCliOverrideDraft(
  type: AgentType | string,
  value: Record<string, number>,
  editing: boolean,
): CliOverrideDraft {
  const specs = useMemo(() => cliConfigOverridesFor(type), [type]);
  const saved = fingerprint(specs, value);
  const toDraft = (source: Record<string, number>): Record<string, string> =>
    Object.fromEntries(specs.map((spec) => [spec.key, source[spec.key] === undefined ? "" : String(source[spec.key])]));

  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(value));
  // 外部值变了就跟上 —— 渲染期直接改而不是挂 effect:effect 版要么按对象引用比(每帧
  // 都跑),要么多一帧显示旧值。React 允许这种「渲染中根据 props 修正 state」。
  const [syncedTo, setSyncedTo] = useState(saved);
  if (!editing && syncedTo !== saved) {
    setSyncedTo(saved);
    setDraft(toDraft(value));
  }

  // 数字非法时保留用户刚敲的东西,只在下面报错,不静默丢弃。
  const parsed: Record<string, number> = {};
  const errors: string[] = [];
  for (const spec of specs) {
    const raw = (draft[spec.key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push(`${spec.label}要填数字`);
      continue;
    }
    if (n < spec.min || n > spec.max) {
      errors.push(`${spec.label}要在 ${fmtOverrideRange(spec)} 之间`);
      continue;
    }
    parsed[spec.key] = Math.round(n);
  }
  // 依赖项没配上时这一项**根本不会注入**(cliConfigOverrideEnv 会跳过它),所以不能让
  // 它存下去:存了会显示成「已覆盖 80%」,而实际行为跟没配一模一样 —— 静默失败。
  // 判定用 shared 的那份,跟后端 400 是同一句话,别在这儿再写一遍。
  errors.push(...cliConfigOverrideErrors(type, parsed));

  return {
    specs,
    draft,
    set: (key, raw) => setDraft((current) => ({ ...current, [key]: raw })),
    reset: () => setDraft(toDraft(value)),
    parsed,
    errors,
    dirty: fingerprint(specs, parsed) !== saved,
    active: specs.filter((spec) => value[spec.key] !== undefined),
  };
}
