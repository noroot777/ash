import type { PreviewServiceState } from "@ash/shared/preview";

export const previewServiceStatus = {
  starting: "启动中", ready: "运行中", failed: "失败", stopped: "已停止",
} satisfies Record<PreviewServiceState["status"], string>;

export function previewServiceLabels(services: PreviewServiceState[]): Map<string, string> {
  const names = services.map((service) => {
    const name = service.name.replace(/\s*（[^（）]*）$/, "").trim();
    return name.split("/").filter(Boolean).at(-1) || service.name;
  });
  return new Map(services.map((service, index) => [
    service.id,
    names.filter((name) => name === names[index]).length > 1 ? service.name : names[index],
  ]));
}
