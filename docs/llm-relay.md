# 供应商转发与连接诊断

本文描述 Anthropic 1M 转发和 OpenAI 协议转换的本机转发链路。执行器直接访问供应商、不经过这两种转发的请求不受影响。

## 连接与等待时间

转发层按供应商 origin（协议、域名、端口）缓存独立的 HTTP/1.1 连接调度器，不复用进程的全局连接池。同一 origin 的连续请求可复用 keep-alive 连接；并发请求不限制为一条连接，一个请求等待上游时不阻塞其他请求。请求结束后连接回到池中，单个请求取消或超时不关闭整个池。代理配置或连接/响应体空闲超时配置变化时，新请求切换到新池，旧池等待已有请求结束后关闭。

默认连接建立超时为 10 秒。等待响应头的上限为：

| 请求 | 默认上限 |
| --- | --- |
| GET / HEAD，例如模型列表 | 15 秒 |
| POST 等请求，例如推理 | 300 秒 |

较长的推理首包窗口保留了大上下文预填充的等待空间。`ASH_LLM_RELAY_HEADERS_TIMEOUT_MS` 可覆盖两类请求的响应头等待上限，单位为毫秒，例如 `180000`。无效值沿用默认值。

收到响应头后，响应头计时器立即取消。响应体保留独立的 300 秒空闲超时：连续 300 秒没有收到下一块数据就终止读取；`ASH_LLM_RELAY_BODY_TIMEOUT_MS` 可单独调整该上限，单位为毫秒，无效值（包括 `0`）沿用默认值。持续收到数据或 SSE 心跳会重置空闲计时，因此健康长流不受总时长限制。客户端停止或取消读取只中止该请求，不影响池中其他并行请求。

远端供应商访问保留 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 配置，小写变量优先；`localhost`、`127.0.0.1`、`[::1]` 始终直连。

ash 不额外自动重发转发请求，包括 POST 推理请求；CLI 自身的重试行为不变。上游实际返回的 HTTP 状态和错误正文仍透传。

## 报错与日志

本机连接失败返回 502，连接或响应头等待超时返回 504，客户端取消归类为 499。响应流已经开始后发生的故障不能改写已发送的 HTTP 状态，但会记录流阶段的诊断，并终止该流。

透传响应、成功转换的响应和本机连接错误响应携带 `x-ash-relay-request-id`。本机连接错误正文也带有相同诊断号，可与服务日志中的 `[ash][llm-relay]` 条目对应；请求校验和协议转换本身的错误不属于这类连接诊断：

```json
{"requestId":"...","upstream":"https://provider.example","method":"POST","phase":"headers","status":504,"elapsedMs":300000,"codes":["ASH_RELAY_HEADERS_TIMEOUT"]}
```

`codes` 保留底层 `cause` 和聚合错误里的错误码，例如 `ETIMEDOUT`、`EADDRNOTAVAIL`、`ECONNREFUSED`、`UND_ERR_SOCKET`。`phase` 区分响应头之前和流读取阶段；流空闲超时记录 `phase: "stream"`、`status: 504`、`UND_ERR_BODY_TIMEOUT` 和诊断号，已发送的 HTTP 状态不会被改写。`HTTP_503` 等代码表示供应商实际返回的 HTTP 错误，而不是本机连接失败。

诊断不记录 API Key、授权头、请求正文、完整上游 URL、查询参数或原始异常消息，仅记录上游 origin、方法、阶段、状态、耗时和错误码。

## 回归验证

```bash
npm -w server run test:llm-relay
npm -w server run test:anthropic-context-1m
npm -w server run test:openai-converter
```

覆盖全局连接池故障隔离、keep-alive 复用、并行挂起请求、响应头与流空闲超时、不重发 POST、持续有心跳的长流、客户端取消不影响并行请求、流中断、代理配置切换和诊断脱敏。
