import type { ReactNode } from "react";

export interface InspectorDescriptor<Context> {
  id: string;
  title: string;
  icon: ReactNode;
  render: (context: Context) => ReactNode;
  defaultOpen?: boolean;
}

export interface InspectorHostControls {
  visible: boolean;
  toggle: () => void;
  toggleButton: ReactNode;
}
