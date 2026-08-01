import { asNumber, asString, convertId, generatedId, isObject, unixSeconds, type JsonObject } from "./common.js";

function responseUsageToChat(usage: unknown): JsonObject | undefined {
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

export function responsesToChatResponse(input: unknown): JsonObject {
  if (!isObject(input)) throw new Error("Responses 响应必须是 JSON 对象");
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: JsonObject[] = [];
  let refusal: string | undefined;
  for (const item of Array.isArray(input.output) ? input.output : []) {
    if (!isObject(item)) continue;
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isObject(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
        if (part.type === "refusal") refusal = asString(part.refusal) ?? asString(part.text) ?? "";
      }
    } else if (item.type === "reasoning") {
      for (const part of Array.isArray(item.summary) ? item.summary : []) {
        if (isObject(part) && typeof part.text === "string") reasoning.push(part.text);
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: asString(item.call_id) ?? asString(item.id) ?? generatedId("call_"),
        type: "function",
        function: {
          name: asString(item.name) ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  const status = asString(input.status);
  const message: JsonObject = {
    role: "assistant",
    content: text.length ? text.join("") : null,
  };
  if (refusal !== undefined) message.refusal = refusal;
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (toolCalls.length) message.tool_calls = toolCalls;
  const result: JsonObject = {
    id: convertId(input.id, "chatcmpl-"),
    object: "chat.completion",
    created: asNumber(input.created_at) ?? unixSeconds(),
    model: asString(input.model) ?? "",
    choices: [{
      index: 0,
      message,
      finish_reason: status === "incomplete" ? "length" : toolCalls.length ? "tool_calls" : "stop",
      logprobs: null,
    }],
  };
  const usage = responseUsageToChat(input.usage);
  if (usage) result.usage = usage;
  if (input.service_tier !== undefined) result.service_tier = input.service_tier;
  return result;
}

function chatUsageToResponse(usage: unknown): JsonObject | undefined {
  if (!isObject(usage)) return undefined;
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

export function chatToResponsesResponse(input: unknown): JsonObject {
  if (!isObject(input)) throw new Error("Chat Completions 响应必须是 JSON 对象");
  const output: JsonObject[] = [];
  let incomplete = false;
  for (const choice of Array.isArray(input.choices) ? input.choices : []) {
    if (!isObject(choice) || !isObject(choice.message)) continue;
    const message = choice.message;
    if (choice.finish_reason === "length") incomplete = true;
    if (typeof message.reasoning_content === "string" && message.reasoning_content) {
      output.push({
        id: generatedId("rs_"), type: "reasoning", status: "completed",
        summary: [{ type: "summary_text", text: message.reasoning_content }],
      });
    }
    const refusal = asString(message.refusal);
    const content = asString(message.content);
    if (refusal !== undefined || content !== undefined) {
      output.push({
        id: generatedId("msg_"), type: "message", status: "completed", role: "assistant",
        content: refusal !== undefined
          ? [{ type: "refusal", refusal }]
          : [{ type: "output_text", text: content ?? "", annotations: [] }],
      });
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isObject(call) || !isObject(call.function)) continue;
      const callId = asString(call.id) ?? generatedId("call_");
      output.push({
        id: callId, type: "function_call", status: "completed", call_id: callId,
        name: asString(call.function.name) ?? "",
        arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
      });
    }
  }
  const created = asNumber(input.created) ?? unixSeconds();
  const result: JsonObject = {
    id: convertId(input.id, "resp_"),
    object: "response",
    created_at: created,
    completed_at: unixSeconds(),
    status: incomplete ? "incomplete" : "completed",
    model: asString(input.model) ?? "",
    output,
    error: null,
  };
  if (incomplete) result.incomplete_details = { reason: "max_output_tokens" };
  const usage = chatUsageToResponse(input.usage);
  if (usage) result.usage = usage;
  if (input.service_tier !== undefined) result.service_tier = input.service_tier;
  return result;
}
