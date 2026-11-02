import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmProtocol } from "@ash/shared";
import { api } from "../lib/api.ts";

/**
 * 供应商表单里「这家的模型目录」的**唯一来源**。
 *
 * 表单上有三处要用同一份目录：默认模型、固定模型、1M 上下文模型。以前它们各自
 * 持有一份 state 和一颗「探测模型」按钮，于是上面探到 177 个模型，下面还在说
 * 「还没探测目录」——同一份目录在同一个表单里被问三遍，用户得挨个点一遍。
 * 现在目录提到表单这一层：按哪颗按钮都写进这里，三处同时可见。
 *
 * 身份（供应商 / 协议 / Base URL / Key）一变就作废重来：换了家供应商还留着上一家
 * 的目录，比空着更误导人。
 */
export interface ProviderCatalogIdentity {
  providerId?: string;
  /** `""` = 协议还没选(新建表单的初始态)。那时探不了:请求打哪条路径由它决定。 */
  protocol: LlmProtocol | "";
  baseUrl: string;
  apiKey: string;
}

export interface ProviderCatalog {
  models: string[];
  /** 探测成功过（哪怕返回空列表）。区分「还没探」和「探了没有」，两句提示不一样。 */
  probed: boolean;
  probing: boolean;
  error: string;
  /** 探测一次；并发点多颗按钮只发一条请求。返回拿到的模型名，失败返回 null。 */
  probe: () => Promise<string[] | null>;
}

export function useProviderCatalog(identity: ProviderCatalogIdentity): ProviderCatalog {
  const { providerId, protocol, baseUrl, apiKey } = identity;
  const [models, setModels] = useState<string[]>([]);
  const [probed, setProbed] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  // 三颗按钮共用一条在途请求：谁先点谁发，后点的等同一个 promise。
  const inflight = useRef<Promise<string[] | null> | null>(null);
  const identityRef = useRef({ providerId, protocol, baseUrl, apiKey });
  identityRef.current = { providerId, protocol, baseUrl, apiKey };

  useEffect(() => {
    request.current += 1;
    inflight.current = null;
    setModels([]);
    setProbed(false);
    setProbing(false);
    setError("");
  }, [apiKey, baseUrl, protocol, providerId]);

  const probe = useCallback(() => {
    const current = identityRef.current;
    if (!current.protocol) {
      setError("先选协议");
      return Promise.resolve(null);
    }
    if (!current.baseUrl.trim()) {
      setError("先填写 Base URL");
      return Promise.resolve(null);
    }
    if (inflight.current) return inflight.current;
    const token = ++request.current;
    setProbing(true);
    setError("");
    const task = api.probeModels({
      protocol: current.protocol,
      baseUrl: current.baseUrl.trim(),
      apiKey: current.apiKey.trim() || undefined,
      id: current.providerId,
    }).then(
      (result) => {
        if (request.current !== token) return null;
        setModels(result.models);
        setProbed(true);
        setProbing(false);
        if (!result.models.length) setError("供应商未返回模型");
        return result.models;
      },
      (failure) => {
        if (request.current !== token) return null;
        setProbing(false);
        setError(failure instanceof Error ? failure.message : "模型探测失败");
        return null;
      },
    ).finally(() => {
      if (request.current === token) inflight.current = null;
    });
    inflight.current = task;
    return task;
  }, []);

  return { models, probed, probing, error, probe };
}
