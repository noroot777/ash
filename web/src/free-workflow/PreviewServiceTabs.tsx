import { useEffect, useRef, type KeyboardEvent } from "react";
import type { PreviewServiceState } from "@ash/shared/preview";
import { PreviewServiceStrip } from "./PreviewServiceStrip.tsx";
import { previewServiceLabels, previewServiceStatus } from "./previewServices.ts";

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
  useEffect(() => { selected.current?.focus(); }, []);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [serviceId]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  };
  return <PreviewServiceStrip label="服务日志" tabs onKeyDown={onKeyDown}>
    <button type="button" role="tab" id={previewLogTabId(panelId)} aria-controls={panelId} aria-selected={!serviceId} tabIndex={serviceId ? -1 : 0} ref={!serviceId ? selected : undefined} onClick={() => onSelect(undefined)}>
      <span>全部</span><span className="preview-service-count">{services.length}</span>
    </button>
    {services.map((service) => <button
      key={service.id} type="button" role="tab"
      id={previewLogTabId(panelId, service.id)} aria-controls={panelId}
      aria-label={`${service.name} · ${previewServiceStatus[service.status]}`}
      aria-selected={serviceId === service.id} tabIndex={serviceId === service.id ? 0 : -1}
      ref={serviceId === service.id ? selected : undefined}
      onClick={() => onSelect(service.id)}
    >
      <i className="preview-service-dot" data-status={service.status} aria-hidden="true" />
      <span className="preview-service-tab-name">{labels.get(service.id)}</span>
    </button>)}
  </PreviewServiceStrip>;
}
