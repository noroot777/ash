import type { AgentEvent, QuestionItem } from "@ash/shared";

type PlanEvent = Extract<AgentEvent, { kind: "plan" }>;

export class CodexPlanStream {
  private plans = new Map<string, PlanEvent>();
  awaitingInput = false;

  notification(method: string, params: any): PlanEvent | null {
    const item = params.item;
    const delta = method === "item/plan/delta";
    if (delta && (typeof params.delta !== "string" || !params.delta)) return null;
    if (!delta && !(["item/started", "item/completed"].includes(method) && item?.type === "plan")) return null;
    const id = delta ? params.itemId : item.id;
    if (typeof id !== "string" || !id) return null;
    const previous = this.plans.get(id);
    if (delta && previous?.status === "complete") return null;
    const text = delta ? `${previous?.text ?? ""}${typeof params.delta === "string" ? params.delta : ""}`
      : typeof item.text === "string" ? item.text : previous?.text ?? "";
    const status = method === "item/completed" ? "complete" : "streaming";
    if (previous && previous.text === text && previous.status === status) return null;
    const event: PlanEvent = { kind: "plan", id, text, status };
    this.plans.set(id, event);
    return delta ? { ...event, text: params.delta, delta: true } : event;
  }

  questions(params: any): Extract<AgentEvent, { kind: "userInput" }> | null {
    const questions: QuestionItem[] = (Array.isArray(params.questions) ? params.questions : []).flatMap((question: any) => {
      if (typeof question.question !== "string" || !question.question.trim()) return [];
      const options = (Array.isArray(question.options) ? question.options : []).flatMap((option: any) => {
        if (typeof option.label !== "string") return [];
        return [option.description ? `${option.label}：${option.description}` : option.label];
      });
      return [{ question: question.question, ...(options.length ? { options } : {}) }];
    });
    if (!questions.length) return null;
    this.awaitingInput = true;
    return { kind: "userInput", questions };
  }
}
