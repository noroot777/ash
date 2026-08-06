import {
  asNumber,
  asString,
  generatedId,
  isObject,
  unixSeconds,
  type JsonObject,
} from "./common.js";

type SseMessage = { event?: string; data: string };

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data: string[] = [];
        let event: string | undefined;
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

const encoder = new TextEncoder();
const chatFrame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const responseFrame = (event: string, data: JsonObject) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

function chatChunk(id: string, created: number, model: string, delta: JsonObject, finishReason: unknown = null): JsonObject {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function responseUsage(usage: unknown): JsonObject | null {
  if (!isObject(usage)) return null;
  const converted: JsonObject = {
    input_tokens: asNumber(usage.prompt_tokens) ?? 0,
    output_tokens: asNumber(usage.completion_tokens) ?? 0,
    total_tokens: asNumber(usage.total_tokens) ?? 0,
  };
  if (isObject(usage.prompt_tokens_details)) {
    converted.input_tokens_details = { cached_tokens: asNumber(usage.prompt_tokens_details.cached_tokens) ?? 0 };
  }
  if (isObject(usage.completion_tokens_details)) {
    converted.output_tokens_details = { reasoning_tokens: asNumber(usage.completion_tokens_details.reasoning_tokens) ?? 0 };
  }
  return converted;
}

function chatUsage(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
  const converted: JsonObject = {
    prompt_tokens: asNumber(usage.input_tokens) ?? 0,
    completion_tokens: asNumber(usage.output_tokens) ?? 0,
    total_tokens: asNumber(usage.total_tokens) ?? 0,
  };
  if (isObject(usage.input_tokens_details)) {
    converted.prompt_tokens_details = { cached_tokens: asNumber(usage.input_tokens_details.cached_tokens) ?? 0 };
  }
  if (isObject(usage.output_tokens_details)) {
    converted.completion_tokens_details = { reasoning_tokens: asNumber(usage.output_tokens_details.reasoning_tokens) ?? 0 };
  }
  return converted;
}

type OutputState = {
  index: number;
  id: string;
  kind: "message" | "reasoning" | "function_call";
  text: string;
  name?: string;
  callId?: string;
  part?: "output_text" | "refusal";
};

export function chatStreamToResponses(body: ReadableStream<Uint8Array>, requestedModel: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const responseId = generatedId("resp_");
      const createdAt = unixSeconds();
      let model = requestedModel;
      let sequence = 0;
      let nextOutputIndex = 0;
      let finishReason = "stop";
      let usage: JsonObject | null = null;
      const outputs: OutputState[] = [];
      let message: OutputState | undefined;
      let reasoning: OutputState | undefined;
      const toolCalls = new Map<number, OutputState>();
      const emit = (event: string, data: JsonObject) => {
        data.type = event;
        data.sequence_number = sequence++;
        controller.enqueue(responseFrame(event, data));
      };
      const baseResponse = (): JsonObject => ({
        id: responseId, object: "response", created_at: createdAt, status: "in_progress", model, output: [],
      });
      const ensureMessage = (part: "output_text" | "refusal") => {
        if (message) return message;
        message = { index: nextOutputIndex++, id: generatedId("msg_"), kind: "message", text: "", part };
        outputs.push(message);
        emit("response.output_item.added", {
          output_index: message.index,
          item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
        });
        emit("response.content_part.added", {
          output_index: message.index, item_id: message.id, content_index: 0,
          part: part === "refusal" ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [] },
        });
        return message;
      };
      const ensureReasoning = () => {
        if (reasoning) return reasoning;
        reasoning = { index: nextOutputIndex++, id: generatedId("rs_"), kind: "reasoning", text: "" };
        outputs.push(reasoning);
        emit("response.output_item.added", {
          output_index: reasoning.index,
          item: { id: reasoning.id, type: "reasoning", status: "in_progress", summary: [] },
        });
        emit("response.reasoning_summary_part.added", {
          output_index: reasoning.index, item_id: reasoning.id, summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
        return reasoning;
      };

      try {
        emit("response.created", { response: baseResponse() });
        emit("response.in_progress", { response: baseResponse() });
        for await (const frame of parseSse(body)) {
          if (frame.data === "[DONE]") break;
          let chunk: unknown;
          try {
            chunk = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (!isObject(chunk)) continue;
          if (isObject(chunk.error)) {
            emit("response.failed", {
              response: { ...baseResponse(), status: "failed", error: chunk.error },
            });
            controller.close();
            return;
          }
          model = asString(chunk.model) ?? model;
          if (isObject(chunk.usage)) usage = responseUsage(chunk.usage);
          const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : undefined;
          if (!choice) continue;
          const delta = isObject(choice.delta) ? choice.delta : undefined;
          if (delta) {
            const reasoningDelta = asString(delta.reasoning_content);
            if (reasoningDelta) {
              const state = ensureReasoning();
              state.text += reasoningDelta;
              emit("response.reasoning_summary_text.delta", {
                output_index: state.index, item_id: state.id, summary_index: 0, delta: reasoningDelta,
              });
            }
            const textDelta = asString(delta.content);
            if (textDelta) {
              const state = ensureMessage("output_text");
              state.text += textDelta;
              emit("response.output_text.delta", {
                output_index: state.index, item_id: state.id, content_index: 0, delta: textDelta,
              });
            }
            const refusalDelta = asString(delta.refusal);
            if (refusalDelta) {
              const state = ensureMessage("refusal");
              state.text += refusalDelta;
              emit("response.refusal.delta", {
                output_index: state.index, item_id: state.id, content_index: 0, delta: refusalDelta,
              });
            }
            for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
              if (!isObject(rawCall)) continue;
              const chatIndex = asNumber(rawCall.index) ?? 0;
              let state = toolCalls.get(chatIndex);
              const fn = isObject(rawCall.function) ? rawCall.function : {};
              if (!state) {
                const callId = asString(rawCall.id) ?? generatedId("call_");
                state = {
                  index: nextOutputIndex++, id: callId, callId, kind: "function_call", text: "",
                  name: asString(fn.name) ?? "",
                };
                toolCalls.set(chatIndex, state);
                outputs.push(state);
                emit("response.output_item.added", {
                  output_index: state.index,
                  item: {
                    id: state.id, type: "function_call", status: "in_progress", call_id: state.callId,
                    name: state.name, arguments: "",
                  },
                });
              }
              const argumentsDelta = asString(fn.arguments) ?? "";
              if (argumentsDelta) {
                state.text += argumentsDelta;
                emit("response.function_call_arguments.delta", {
                  output_index: state.index, item_id: state.id, delta: argumentsDelta,
                });
              }
            }
          }
          if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        }

        if (reasoning) {
          emit("response.reasoning_summary_text.done", {
            output_index: reasoning.index, item_id: reasoning.id, summary_index: 0, text: reasoning.text,
          });
          emit("response.reasoning_summary_part.done", {
            output_index: reasoning.index, item_id: reasoning.id, summary_index: 0,
            part: { type: "summary_text", text: reasoning.text },
          });
          emit("response.output_item.done", {
            output_index: reasoning.index,
            item: { id: reasoning.id, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: reasoning.text }] },
          });
        }
        if (message) {
          const part = message.part === "refusal"
            ? { type: "refusal", refusal: message.text }
            : { type: "output_text", text: message.text, annotations: [] };
          emit(message.part === "refusal" ? "response.refusal.done" : "response.output_text.done", {
            output_index: message.index, item_id: message.id, content_index: 0,
            [message.part === "refusal" ? "refusal" : "text"]: message.text,
          });
          emit("response.content_part.done", {
            output_index: message.index, item_id: message.id, content_index: 0, part,
          });
          emit("response.output_item.done", {
            output_index: message.index,
            item: { id: message.id, type: "message", status: "completed", role: "assistant", content: [part] },
          });
        }
        for (const state of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
          emit("response.function_call_arguments.done", {
            output_index: state.index, item_id: state.id, arguments: state.text,
          });
          emit("response.output_item.done", {
            output_index: state.index,
            item: {
              id: state.id, type: "function_call", status: "completed", call_id: state.callId,
              name: state.name, arguments: state.text,
            },
          });
        }
        const status = finishReason === "length" ? "incomplete" : "completed";
        const finalOutput = outputs.sort((a, b) => a.index - b.index).map((state) => {
          if (state.kind === "reasoning") {
            return { id: state.id, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: state.text }] };
          }
          if (state.kind === "message") {
            const part = state.part === "refusal"
              ? { type: "refusal", refusal: state.text }
              : { type: "output_text", text: state.text, annotations: [] };
            return { id: state.id, type: "message", status: "completed", role: "assistant", content: [part] };
          }
          return {
            id: state.id, type: "function_call", status: "completed", call_id: state.callId,
            name: state.name, arguments: state.text,
          };
        });
        const completed: JsonObject = {
          id: responseId, object: "response", created_at: createdAt, completed_at: unixSeconds(),
          status, model, output: finalOutput, usage, error: null,
        };
        if (status === "incomplete") completed.incomplete_details = { reason: "max_output_tokens" };
        emit("response.completed", { response: completed });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function responsesStreamToChat(body: ReadableStream<Uint8Array>, requestedModel: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      let id = `chatcmpl-${generatedId("resp_").slice(5)}`;
      let created = unixSeconds();
      let model = requestedModel;
      let sentRole = false;
      let completed = false;
      const toolIndexes = new Map<string, number>();
      const toolNames = new Map<string, string>();
      const sentTools = new Set<string>();
      const emit = (delta: JsonObject, finishReason: unknown = null, usage?: JsonObject) => {
        const chunk = chatChunk(id, created, model, delta, finishReason);
        if (usage) chunk.usage = usage;
        controller.enqueue(chatFrame(chunk));
      };
      const withRole = (delta: JsonObject) => {
        if (!sentRole) {
          sentRole = true;
          delta.role = "assistant";
        }
        return delta;
      };
      try {
        for await (const frame of parseSse(body)) {
          if (frame.data === "[DONE]") continue;
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
          } catch {
            continue;
          }
          if (!isObject(event)) continue;
          const type = asString(event.type) ?? frame.event ?? "";
          if ((type === "response.created" || type === "response.in_progress") && isObject(event.response)) {
            const response = event.response;
            const responseId = asString(response.id);
            if (responseId) id = responseId.startsWith("resp_") ? `chatcmpl-${responseId.slice(5)}` : responseId;
            created = asNumber(response.created_at) ?? created;
            model = asString(response.model) ?? model;
          } else if (type === "response.output_item.added" && isObject(event.item) && event.item.type === "function_call") {
            const itemId = asString(event.item.id) ?? asString(event.item.call_id) ?? generatedId("call_");
            const index = toolIndexes.size;
            toolIndexes.set(itemId, index);
            toolNames.set(itemId, asString(event.item.name) ?? "");
            sentTools.add(itemId);
            emit(withRole({ tool_calls: [{
              index, id: asString(event.item.call_id) ?? itemId, type: "function",
              function: { name: toolNames.get(itemId), arguments: "" },
            }] }));
          } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
            emit(withRole({ content: event.delta }));
          } else if (type === "response.refusal.delta" && typeof event.delta === "string") {
            emit(withRole({ refusal: event.delta }));
          } else if (type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
            emit(withRole({ reasoning_content: event.delta }));
          } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
            const itemId = asString(event.item_id) ?? "";
            let index = toolIndexes.get(itemId);
            if (index === undefined) {
              index = toolIndexes.size;
              toolIndexes.set(itemId, index);
            }
            const toolCall: JsonObject = { index, function: { arguments: event.delta } };
            if (!sentTools.has(itemId)) {
              sentTools.add(itemId);
              toolCall.id = itemId;
              toolCall.type = "function";
              (toolCall.function as JsonObject).name = toolNames.get(itemId) ?? "";
            }
            emit(withRole({ tool_calls: [toolCall] }));
          } else if (type === "response.failed") {
            const response = isObject(event.response) ? event.response : event;
            controller.enqueue(chatFrame({ error: response.error ?? { message: "Responses 上游请求失败" } }));
            controller.enqueue(chatFrame("[DONE]"));
            completed = true;
            break;
          } else if (type === "response.completed" && isObject(event.response)) {
            const response = event.response;
            const usage = chatUsage(response.usage);
            const finish = response.status === "incomplete" ? "length" : toolIndexes.size ? "tool_calls" : "stop";
            emit({}, finish, usage);
            controller.enqueue(chatFrame("[DONE]"));
            completed = true;
            break;
          }
        }
        if (!completed) controller.enqueue(chatFrame("[DONE]"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
