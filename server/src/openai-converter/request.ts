import { asBoolean, asNumber, asString, copyDefined, isObject, type JsonObject } from "./common.js";

function responseContentToChat(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isObject(part)) return part;
    if (part.type === "input_text" || part.type === "output_text") {
      return { type: "text", text: asString(part.text) ?? "" };
    }
    if (part.type === "input_image") {
      const imageUrl = asString(part.image_url) ?? "";
      const converted: JsonObject = { type: "image_url", image_url: { url: imageUrl } };
      if (typeof part.detail === "string") (converted.image_url as JsonObject).detail = part.detail;
      return converted;
    }
    return part;
  });
}

function appendResponseInput(messages: JsonObject[], input: unknown) {
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return;
  }
  const items = Array.isArray(input) ? input : isObject(input) ? [input] : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: asString(item.call_id) ?? asString(item.id) ?? "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.type === "function_call") {
      const call = {
        id: asString(item.call_id) ?? asString(item.id) ?? "",
        type: "function",
        function: {
          name: asString(item.name) ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      };
      const previous = messages.at(-1);
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls) && previous.content === null) {
        previous.tool_calls.push(call);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }
    if (item.type === "reasoning") continue;
    // Responses API 支持 developer；不少 OpenAI-compatible Chat 端点（百炼等）
    // 只认 system/user/assistant/tool。developer 语义最接近 system，必须在这里降级。
    const sourceRole = asString(item.role) || "user";
    const role = sourceRole === "developer" ? "system" : sourceRole;
    messages.push({ role, content: responseContentToChat(item.content) });
  }
}

function responseToolsToChat(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const converted: JsonObject[] = [];
  for (const tool of tools) {
    if (!isObject(tool) || tool.type !== "function") continue;
    const fn: JsonObject = { name: asString(tool.name) ?? "" };
    copyDefined(fn, tool, ["description", "parameters", "strict"]);
    converted.push({ type: "function", function: fn });
  }
  return converted.length ? converted : undefined;
}

function responseToolChoiceToChat(choice: unknown): unknown {
  if (!isObject(choice) || choice.type !== "function") return choice;
  return { type: "function", function: { name: asString(choice.name) ?? "" } };
}

function responseTextToChat(text: unknown): JsonObject | undefined {
  if (!isObject(text) || !isObject(text.format)) return undefined;
  const format = text.format;
  if (format.type === "json_schema") {
    const schema: JsonObject = { name: asString(format.name) ?? "response" };
    copyDefined(schema, format, ["description", "schema", "strict"]);
    return { type: "json_schema", json_schema: schema };
  }
  if (format.type === "json_object" || format.type === "text") return { type: format.type };
  return undefined;
}

export function responsesToChatRequest(input: unknown): JsonObject {
  if (!isObject(input)) throw new Error("Responses 请求体必须是 JSON 对象");
  const result: JsonObject = {
    model: asString(input.model) ?? "",
    stream: asBoolean(input.stream) ?? false,
  };
  const messages: JsonObject[] = [];
  if (typeof input.instructions === "string" && input.instructions) {
    messages.push({ role: "system", content: input.instructions });
  }
  appendResponseInput(messages, input.input);
  result.messages = messages;

  const maxOutputTokens = asNumber(input.max_output_tokens);
  if (maxOutputTokens !== undefined) result.max_completion_tokens = maxOutputTokens;
  copyDefined(result, input, [
    "temperature", "top_p", "frequency_penalty", "presence_penalty", "store", "metadata",
    "service_tier", "parallel_tool_calls", "user",
  ]);
  const topLogprobs = asNumber(input.top_logprobs);
  if (topLogprobs !== undefined && topLogprobs > 0) {
    result.logprobs = true;
    result.top_logprobs = topLogprobs;
  }
  if (isObject(input.reasoning) && typeof input.reasoning.effort === "string") {
    result.reasoning_effort = input.reasoning.effort;
  }
  const responseFormat = responseTextToChat(input.text);
  if (responseFormat) result.response_format = responseFormat;
  if (isObject(input.text) && typeof input.text.verbosity === "string") result.verbosity = input.text.verbosity;
  const tools = responseToolsToChat(input.tools);
  if (tools) result.tools = tools;
  if (input.tool_choice !== undefined) result.tool_choice = responseToolChoiceToChat(input.tool_choice);
  if (result.stream === true) result.stream_options = { include_usage: true };
  return result;
}

function chatContentToResponse(content: unknown, assistant: boolean): unknown {
  if (typeof content === "string") {
    return assistant
      ? [{ type: "output_text", text: content, annotations: [] }]
      : content;
  }
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!isObject(part)) return part;
    if (part.type === "text") return { type: assistant ? "output_text" : "input_text", text: asString(part.text) ?? "" };
    if (part.type === "image_url" && isObject(part.image_url)) {
      const converted: JsonObject = { type: "input_image", image_url: asString(part.image_url.url) ?? "" };
      if (typeof part.image_url.detail === "string") converted.detail = part.image_url.detail;
      return converted;
    }
    return part;
  });
}

function chatToolsToResponse(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const converted: JsonObject[] = [];
  for (const tool of tools) {
    if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function)) continue;
    const output: JsonObject = { type: "function", name: asString(tool.function.name) ?? "" };
    copyDefined(output, tool.function, ["description", "parameters", "strict"]);
    converted.push(output);
  }
  return converted.length ? converted : undefined;
}

function chatToolChoiceToResponse(choice: unknown): unknown {
  if (!isObject(choice) || choice.type !== "function" || !isObject(choice.function)) return choice;
  return { type: "function", name: asString(choice.function.name) ?? "" };
}

export function chatToResponsesRequest(input: unknown): JsonObject {
  if (!isObject(input)) throw new Error("Chat Completions 请求体必须是 JSON 对象");
  const result: JsonObject = {
    model: asString(input.model) ?? "",
    stream: asBoolean(input.stream) ?? false,
  };
  const instructions: string[] = [];
  const responseInput: JsonObject[] = [];
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!isObject(message)) continue;
    const role = asString(message.role) ?? "user";
    if (role === "system" || role === "developer") {
      if (typeof message.content === "string") instructions.push(message.content);
      continue;
    }
    if (role === "tool") {
      responseInput.push({ type: "function_call_output", call_id: asString(message.tool_call_id) ?? "", output: message.content ?? "" });
      continue;
    }
    if (role === "assistant") {
      if (message.content !== undefined && message.content !== null) {
        responseInput.push({ type: "message", role, status: "completed", content: chatContentToResponse(message.content, true) });
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!isObject(call) || !isObject(call.function)) continue;
        const callId = asString(call.id) ?? "";
        responseInput.push({
          type: "function_call", id: callId, call_id: callId, status: "completed",
          name: asString(call.function.name) ?? "",
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
        });
      }
      continue;
    }
    responseInput.push({ role, content: chatContentToResponse(message.content, false) });
  }
  result.input = responseInput;
  if (instructions.length) result.instructions = instructions.join("\n\n");
  const maxTokens = asNumber(input.max_completion_tokens) ?? asNumber(input.max_tokens);
  if (maxTokens !== undefined) result.max_output_tokens = maxTokens;
  copyDefined(result, input, [
    "temperature", "top_p", "frequency_penalty", "presence_penalty", "store", "metadata",
    "service_tier", "parallel_tool_calls", "user", "top_logprobs",
  ]);
  if (typeof input.reasoning_effort === "string") result.reasoning = { effort: input.reasoning_effort };
  if (isObject(input.response_format)) {
    const format = input.response_format;
    result.text = format.type === "json_schema" && isObject(format.json_schema)
      ? { format: { type: "json_schema", ...format.json_schema } }
      : { format: { type: format.type } };
  }
  const tools = chatToolsToResponse(input.tools);
  if (tools) result.tools = tools;
  if (input.tool_choice !== undefined) result.tool_choice = chatToolChoiceToResponse(input.tool_choice);
  return result;
}
