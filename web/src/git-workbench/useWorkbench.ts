import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitAction,
  GitActionRequest,
  GitWorkbenchState,
} from "@ash/shared/git-workbench";
import { workbenchApi } from "./api.ts";

export function useWorkbench(
  projectId: string,
  root: string | undefined,
  taskId: string | undefined,
  notify: (message: string) => void,
) {
  const [data, setData] = useState<GitWorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const next = await workbenchApi.state(projectId, root, taskId);
      if (!mounted.current || sequence.current !== request) return;
      setData(next);
      setError(null);
    } catch (reason) {
      if (mounted.current && sequence.current === request)
        setError(reason instanceof Error ? reason.message : "Git 状态读取失败");
    } finally {
      if (mounted.current && sequence.current === request) setLoading(false);
    }
  }, [projectId, root, taskId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      clearInterval(timer);
      sequence.current++;
    };
  }, [refresh]);
  const run = async (
    action: GitAction,
    confirmation?: string,
    snapshot?: Pick<GitActionRequest, "root" | "version">,
  ): Promise<boolean> => {
    if (!data || data.readOnly || error || running.current) return false;
    running.current = true;
    sequence.current++;
    setBusy(true);
    setMessage(null);
    let succeeded = false;
    try {
      const result = await workbenchApi.action(projectId, {
        action,
        root: snapshot?.root || data.root,
        version: snapshot?.version || data.version,
        confirmation,
      });
      succeeded = true;
      if (mounted.current) {
        setMessage(result.message);
        setRevision((value) => value + 1);
      }
      notify(result.message);
    } catch (reason) {
      const text =
        reason instanceof Error
          ? reason.message
          : "Git 操作失败，请查看操作日志";
      if (mounted.current) setMessage(text);
      notify(text);
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        await refresh();
      }
    }
    return succeeded;
  };
  return {
    data,
    error,
    message,
    busy,
    loading,
    revision,
    refresh,
    run,
    blocked: busy || !!error || !!data?.readOnly,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
