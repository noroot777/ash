import { useState } from "react";
import type { LlmProvider } from "@ash/shared";
import { CheckCircle, Plus } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { protocolLabel } from "../settings/agentProviderRules.ts";
import { ProviderForm } from "../settings/ProvidersSection.tsx";

/**
 * 第一站:模型从哪儿来。
 *
 * 表单本体直接用设置页那一份(`ProvidersSection.tsx` 导出的 `ProviderForm`):协议、
 * BaseURL、Key、模型目录、1M 声明之间的联动规则只该有一处实现。
 *
 * 这一站**可以空着过**,而且多数人就该空着过 —— CLI 自己的订阅账号是出厂路径。所以
 * 没有供应商时直接摊开表单(想填的人少一次点击),表单收起来之后只剩一颗「添加供应商」。
 */
export function ProviderStep({ providers, onChanged, notify }: {
  providers: LlmProvider[];
  onChanged: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [adding, setAdding] = useState(providers.length === 0);

  return (
    <>
      {!!providers.length && (
        <ul className="onboarding-rows">
          {providers.map((provider) => (
            <li key={provider.id}>
              <span className={`provider-protocol is-${provider.protocol}`}>
                {provider.protocol === "anthropic" ? "A" : "O"}
              </span>
              <div>
                <b>{provider.name}</b>
                <small>{protocolLabel(provider.protocol)} · {provider.baseUrl}</small>
              </div>
              <span className={`provider-key-state${provider.hasKey ? " is-ready" : ""}`}>
                {provider.hasKey && <CheckCircle size={12} weight="fill" />}
                {provider.hasKey ? "Key 已保存" : "缺少 Key"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <ProviderForm
          notify={notify}
          onCancel={() => setAdding(false)}
          onSaved={async () => {
            await onChanged();
            setAdding(false);
            notify("供应商已添加");
          }}
        />
      ) : (
        <Button className="onboarding-add" onClick={() => setAdding(true)}>
          <Plus size={12} weight="bold" aria-hidden="true" />
          添加供应商
        </Button>
      )}
    </>
  );
}
