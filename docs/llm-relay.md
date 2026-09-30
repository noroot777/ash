# 供应商转发与连接诊断

本文描述 Anthropic 1M 转发和 OpenAI 协议转换的本机转发链路。执行器直接访问供应商、不经过这两种转发的请求不受影响。

## 连接与等待时间

每个转发请求使用独立的 HTTP/1.1 连接调度器，不复用进程的全局连接池。一个请求等待上游时，不会占住另一个请求的转发连接；连接在响应读取完成、取消或失败后释放。代价是每次请求重新建立连接，HTTPS 请求也重新进行 TLS 握手。

默认连接建立超时为 10 秒。等待响应头的上限为：

| 请求 | 默认上限 |
| --- | --- |
| GET / HEAD，例如模型列表 | 15 秒 |
| POST 等请求，例如推理 | 300 秒 |

较长的推理首包窗口保留了大上下文预填充的等待空间。`ASH_LLM_RELAY_HEADERS_TIMEOUT_MS` 可覆盖两类请求的响应头等待上限，单位为毫秒，例如 `180000`。无效值沿用默认值。

收到响应头后，该计时器立即取消，不对已经开始的 SSE 流施加总时长或空闲读取时长限制。客户端停止或取消读取仍会关闭上游连接。

远端供应商访问保留 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 配置，小写变量优先；`localhost`、`127.0.0.1`、`[::1]` 始终直连。

ash 不额外自动重发转发请求，包括 POST 推理请求；CLI 自身的重试行为不变。上游实际返回的 HTTP 状态和错误正文仍透传。

## 报错与日志

本机连接失败返回 502，连接或响应头等待超时返回 504，客户端取消归类为 499。响应流已经开始后发生的故障不能改写已发送的 HTTP 状态，但会记录流阶段的诊断，并终止该流。

透传响应、成功转换的响应和本机连接错误响应携带 `x-ash-relay-request-id`。本机连接错误正文也带有相同诊断号，可与服务日志中的 `[ash][llm-relay]` 条目对应；请求校验和协议转换本身的错误不属于这类连接诊断：

```json
{"requestId":"...","upstream":"https://provider.example","method":"POST","phase":"headers","status":504,"elapsedMs":300000,"codes":["ASH_RELAY_HEADERS_TIMEOUT"]}
```

`codes` 保留底层 `cause` 和聚合错误里的错误码，例如 `ETIMEDOUT`、`EADDRNOTAVAIL`、`ECONNREFUSED`、`UND_ERR_SOCKET`。`phase` 区分响应头之前和流读取阶段；`HTTP_503` 等代码表示供应商实际返回的 HTTP 错误，而不是本机连接失败。

诊断不记录 API Key、授权头、请求正文、完整上游 URL、查询参数或原始异常消息，仅记录上游 origin、方法、阶段、状态、耗时和错误码。

## 回归验证

```bash
npm -w server run test:llm-relay
npm -w server run test:anthropic-context-1m
npm -w server run test:openai-converter
```

覆盖全局连接池故障隔离、并行挂起请求、超时、不重发 POST、长流、客户端取消、流中断、代理配置和诊断脱敏。
