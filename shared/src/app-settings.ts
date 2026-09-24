import type { HandoffTarget } from "./handoff.ts";

export interface AppSettings {
  defaultWorkflowId: string;
  skillRefreshSeconds: number;
  claudeModelRefreshHours: number;
  claudeCustomModelIds: string[];
  handoffTargets: HandoffTarget[];
  handoffRequireApproval: boolean;
  handoffEncrypt: boolean;
  handoffMaxBodyMb: number;
  instanceMode: "" | "single" | "multi";
  rootDir: string;
  sharedHostCli: boolean;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  defaultWorkflowId: "",
  skillRefreshSeconds: 3600,
  claudeModelRefreshHours: 6,
  claudeCustomModelIds: [],
  handoffTargets: [],
  handoffRequireApproval: true,
  handoffEncrypt: true,
  handoffMaxBodyMb: 512,
  instanceMode: "",
  rootDir: "",
  sharedHostCli: false,
});
