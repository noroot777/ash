export interface PreviewServiceConfig {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  kind: "web" | "service";
}

export interface ProjectPreviewConfig {
  mode: "script" | "services";
  proxy: "auto" | "on" | "off";
  primaryServiceId: string | null;
  services: PreviewServiceConfig[];
}

export interface DetectedPreviewService extends PreviewServiceConfig {
  directory: string;
}

export interface WorkspacePreviewInput {
  workspace: true;
  command?: string;
  config?: ProjectPreviewConfig;
  stepId?: string;
}

export interface WorkspacePreviewLaunch {
  kind: "free" | "workflow";
  reason: string;
  directory: string | null;
  candidates: Array<DetectedPreviewService & { requiresSelection?: boolean }>;
  configured: { command: string; config?: ProjectPreviewConfig } | null;
  steps: Array<{ id: string; command: string }>;
  truncated: boolean;
}

export interface PreviewServiceState {
  id: string;
  name: string;
  command: string;
  status: "starting" | "ready" | "stopped" | "failed";
  url: string | null;
  port: number | null;
}

export const MAX_PREVIEW_SCRIPT_LENGTH = 16_000;
export const MAX_PREVIEW_SERVICES = 8;

export function previewProxyEnabled(setting: ProjectPreviewConfig["proxy"] | undefined, multi: boolean): boolean {
  return setting === "on" || (setting !== "off" && multi);
}

export function parsePreviewConfig(value: unknown): ProjectPreviewConfig | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("预览配置格式不正确");
  const v = value as Record<string, unknown>;
  if (v.mode !== "script" && v.mode !== "services") throw new Error("请选择脚本或服务列表");
  if (v.proxy !== "auto" && v.proxy !== "on" && v.proxy !== "off") throw new Error("请选择预览访问方式");
  if (!Array.isArray(v.services) || v.services.length > 40) throw new Error("服务列表最多保存 40 项");
  const ids = new Set<string>();
  const services = v.services.map((item): PreviewServiceConfig => {
    if (!item || typeof item !== "object") throw new Error("服务配置格式不正确");
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || ids.has(s.id)) throw new Error("服务标识无效或重复");
    ids.add(s.id);
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 160) throw new Error("请填写服务名称（最多 160 字）");
    if (typeof s.command !== "string" || s.command.length > MAX_PREVIEW_SCRIPT_LENGTH || s.command.includes("\0")) throw new Error("服务脚本无效或过长");
    if (typeof s.enabled !== "boolean" || (s.kind !== "web" && s.kind !== "service")) throw new Error("服务类型或选择状态不正确");
    if (s.enabled && !s.command.trim()) throw new Error(`请填写「${s.name}」的启动脚本`);
    return { id: s.id, name: s.name.trim(), command: s.command.trim(), enabled: s.enabled, kind: s.kind };
  });
  const selected = services.filter((s) => s.enabled);
  if (selected.length > MAX_PREVIEW_SERVICES) throw new Error(`一次最多启动 ${MAX_PREVIEW_SERVICES} 个服务`);
  if (v.mode === "services" && !selected.length) throw new Error("请至少选择一个服务");
  const primary = v.primaryServiceId;
  if (primary !== null && (typeof primary !== "string" || !selected.some((s) => s.id === primary))) throw new Error("默认预览服务必须在已选服务中");
  return withoutBlankServices({ mode: v.mode, proxy: v.proxy, primaryServiceId: primary as string | null, services });
}

// 「手动添加」后没填脚本又没勾选就离开，会留下一条空壳服务。它启动不了任何东西，
// 却会被存进配置、下次打开「选择服务」时凭空出现，看着像系统自动加的。存取两头都丢掉。
export function withoutBlankServices(config: ProjectPreviewConfig): ProjectPreviewConfig {
  const services = config.services.filter((s) => s.command.trim() || s.enabled);
  if (services.length === config.services.length) return config;
  return { ...config, services, primaryServiceId: services.some((s) => s.id === config.primaryServiceId) ? config.primaryServiceId : null };
}
