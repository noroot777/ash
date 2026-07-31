import type { ReactNode } from "react";

export interface InspectorDescriptor<Context = unknown> {
  id: string;
  title: string;
  icon: ReactNode;
  description?: string;
  render: (context: Context) => ReactNode;
}

export interface InspectorPersistedState {
  openIds: string[];
  activeId: string | null;
  width: number;
  visible: boolean;
}

export const INSPECTOR_DEFAULT_WIDTH = 340;
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 720;
