// 「信息」格里我说过的话：后续追问（折成一行「N 条」，点开再看）和续跑指令那一行。原始需求
// 不在这里，它是会话流里的第一颗气泡。附件链接、图片预览照旧走 InspectorPromptContent。
import { useEffect, useState } from "react";
import { CaretRight } from "@phosphor-icons/react";
import { InspButton, InspRow } from "../../inspector/parts.tsx";
import { isSendKeyEvent } from "../../lib/sendKey.ts";
import { useSendKeyLabels } from "../../lib/useComposerSendKey.ts";
import { InspectorPromptContent } from "../InspectorPromptContent.tsx";
import { formatInstant } from "../utils.ts";
import { AutoTextarea } from "../../components/AutoTextarea.tsx";

export interface InfoFollowUp { text: string; attachments: string[]; at?: string }

/** 后续追问：一行「N 条」，点开在下面整行铺开。 */
export function InfoFollowUps({ followUps }: { followUps: InfoFollowUp[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <InspRow label="追问">
        {followUps.length ? (
          <button type="button" className="insp-val" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            <span className="insp-num">{followUps.length} 条</span>
            <CaretRight size={12} className="insp-rot" aria-hidden="true" />
          </button>
        ) : <span className="insp-faint">无</span>}
      </InspRow>
      {open && followUps.length > 0 && (
        <InspRow wide>
          <ol className="insp-asks">
            {followUps.map((followUp, index) => (
              <li key={`${followUp.at ?? "pending"}:${index}`}>
                {followUp.at && <time dateTime={followUp.at}>{formatInstant(followUp.at)}</time>}
                <InspectorPromptContent text={followUp.text} attachments={followUp.attachments} emptyText="（空消息）" />
              </li>
            ))}
          </ol>
        </InspRow>
      )}
    </>
  );
}

/**
 * 续跑指令：下次唤醒时发给执行器的那句话。平时一行字（没设就是「未设置」）；任务暂停、
 * 没在等答复时它是颗可改的值，点了底下整行铺开一个输入框。
 */
export function InfoResumePrompt({ value, editable, onSave }: {
  value: string;
  editable: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const sendKeys = useSendKeyLabels();
  const text = value.trim();

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const commit = async (nextValue = draft) => {
    const normalized = nextValue.trim();
    if (normalized === text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      if (await onSave(normalized)) {
        setDraft(normalized);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const shown = text || "未设置";
  return (
    <>
      <InspRow label="续跑指令">
        {editable ? (
          <button
            type="button"
            className={`insp-val${text ? "" : " insp-faint"}`}
            aria-expanded={editing}
            aria-label={text ? `续跑指令：${text}；点击修改` : "续跑指令未设置，续跑时用标准的「继续」；点击添加"}
            onClick={() => setEditing((current) => !current)}
          >
            <span className="insp-clamp">{shown}</span>
          </button>
        ) : <span className={`insp-clamp${text ? "" : " insp-faint"}`}>{shown}</span>}
      </InspRow>
      {editing && editable && (
        <InspRow wide>
          <AutoTextarea
            className="insp-field"
            autoFocus
            rows={4}
            value={draft}
            aria-label="续跑指令"
            placeholder="续跑时发送给执行器的消息，例如：继续完成 TTS 阶段"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isSendKeyEvent(event)) {
                event.preventDefault();
                void commit();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(value);
                setEditing(false);
              }
            }}
          />
          <div className="insp-inline-acts">
            <span className="insp-faint">{sendKeys.send} 保存</span>
            {text && <InspButton variant="quiet" size="sm" disabled={saving} onClick={() => void commit("")}>清空</InspButton>}
            <InspButton variant="quiet" size="sm" disabled={saving} onClick={() => { setDraft(value); setEditing(false); }}>取消</InspButton>
            <InspButton variant="pri" size="sm" disabled={saving} onClick={() => void commit()}>{saving ? "保存中…" : "保存"}</InspButton>
          </div>
        </InspRow>
      )}
    </>
  );
}
