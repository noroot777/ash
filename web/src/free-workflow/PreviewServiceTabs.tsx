import { useEffect, useRef } from "react";
import type { PreviewServiceState } from "@ash/shared/preview";
import { useRovingChoice } from "../lib/useRovingChoice.ts";
import { PreviewServiceStrip } from "./PreviewServiceStrip.tsx";
import { previewServiceLabels, previewServiceStatus } from "./previewServices.ts";

// 「全部」这一档在数据上是 `undefined`(= 不筛服务),到了漫游契约里得有个取值才排得上
// 队。服务 id 是建服务时生成的,撞不上这个前缀。
const ALL = "__all__";

export function previewLogTabId(panelId: string, serviceId?: string): string {
  return `${panelId}-${serviceId ? `service-${serviceId}` : "all"}`;
}

export function PreviewServiceTabs({ services, serviceId, panelId, onSelect }: {
  services: PreviewServiceState[];
  serviceId?: string;
  panelId: string;
  onSelect: (id: string | undefined) => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  const labels = previewServiceLabels(services);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [serviceId]);
  // 左右键换页签走公共那一份(lib/useRovingChoice.ts);tablist 的 role 由 strip 的
  // `tabs` 开关落在真正能滚的那层容器上,所以这里只摊 itemProps。
  const tabs = useRovingChoice(
    [ALL, ...services.map((service) => service.id)],
    serviceId ?? ALL,
    (picked) => onSelect(picked === ALL ? undefined : picked),
    "tab",
  );
  return <PreviewServiceStrip label="服务日志" tabs>
    <button type="button" {...tabs.itemProps(ALL)} id={previewLogTabId(panelId)} aria-controls={panelId}
      ref={!serviceId ? selected : undefined} onClick={() => onSelect(undefined)}>
      <span>全部</span><span className="preview-service-count">{services.length}</span>
    </button>
    {services.map((service) => <button
      key={service.id} type="button" {...tabs.itemProps(service.id)}
      id={previewLogTabId(panelId, service.id)} aria-controls={panelId}
      aria-label={`${service.name} · ${previewServiceStatus[service.status]}`}
      ref={serviceId === service.id ? selected : undefined}
      onClick={() => onSelect(service.id)}
    >
      <i className="preview-service-dot" data-status={service.status} aria-hidden="true" />
      <span className="preview-service-tab-name">{labels.get(service.id)}</span>
    </button>)}
  </PreviewServiceStrip>;
}
