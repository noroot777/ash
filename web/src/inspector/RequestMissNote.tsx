import type { InspectorRequest, InspectorRequestMiss } from "./nav.tsx";
import { InspButton, InspNote } from "./parts.tsx";

/**
 * 别处点过来要打开的那一条，重读过一遍也没找到：说一声是哪一条，给「重试」（原样再找一次）。
 * 不说的话，用户看到的只是「切过来了、什么都没展开」，分不清是没点上还是没有这一条。
 */
export function RequestMissNote({ miss, what }: { miss: InspectorRequestMiss | null; what: (params: InspectorRequest) => string }) {
  if (!miss) return null;
  return (
    <InspNote
      tone="warn"
      role="alert"
      action={(
        <>
          <InspButton size="sm" onClick={miss.retry}>重试</InspButton>
          <InspButton size="sm" variant="quiet" onClick={miss.dismiss}>知道了</InspButton>
        </>
      )}
    >
      没找到要打开的{what(miss.params)}：它可能还没写进来，或者已经不在了。
    </InspNote>
  );
}
