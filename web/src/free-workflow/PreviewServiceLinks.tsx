import type { PreviewServiceState } from "@ash/shared/preview";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { browserPreviewUrl } from "../lib/previewUrl.ts";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { PreviewServiceStrip } from "./PreviewServiceStrip.tsx";
import { previewServiceLabels, previewServiceStatus } from "./previewServices.ts";

function ServiceLink({ service, label }: { service: PreviewServiceState; label: string }) {
  const tip = useHoverTip();
  return <>
    <a href={browserPreviewUrl(service.url!)} target="_blank" rel="noreferrer" aria-label={`打开 ${service.name}`} {...tip.anchorProps} onClick={tip.hide}>
      <i className="preview-service-dot" data-status={service.status} aria-hidden="true" />
      <span>{label}</span><ArrowSquareOut size={12} aria-hidden="true" />
    </a>
    <HoverTip at={tip.at}>{service.name} · {previewServiceStatus[service.status]}</HoverTip>
  </>;
}

export function PreviewServiceLinks({ services, url }: { services: PreviewServiceState[]; url: string | null }) {
  if (services.length < 2) {
    const href = services.length ? services[0].url : url;
    return href && <a href={browserPreviewUrl(href)} target="_blank" rel="noreferrer" aria-label="在新窗口打开预览"><ArrowSquareOut size={13} /><span>预览页</span></a>;
  }
  const links = services.filter((service) => service.url);
  if (!links.length) return null;
  const labels = previewServiceLabels(services);
  return <div className="preview-service-links">
    <span className="preview-service-links-label">预览页</span>
    <PreviewServiceStrip label="预览服务">
      {links.map((service) => <ServiceLink key={service.id} service={service} label={labels.get(service.id)!} />)}
    </PreviewServiceStrip>
  </div>;
}
