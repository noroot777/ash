import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 供应商(relay), system-level. 挂给执行器用:启动 CLI 时注入 base_url + key,
// 顶掉 CLI 自己的官方登录账号。ash 自己不再直连 HTTP 调模型。
export const llmProviders = sqliteTable("llm_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protocol: text("protocol").notNull().default("openai"), // anthropic | openai
  baseUrl: text("base_url").notNull(), // 根地址,不含 /v1(各处按需自行补)
  apiKey: text("api_key").notNull().default(""), // 本机存储,GET 不回传明文
  model: text("model").notNull().default(""),
  protocolConversionEnabled: integer("protocol_conversion_enabled", { mode: "boolean" }).notNull().default(false),
  // 选模型面板的候选来源:'api'=每次现调 /models;'pinned'=只用 pinned_models(json string[])。
  modelListMode: text("model_list_mode").notNull().default("api"),
  pinnedModels: text("pinned_models").notNull().default("[]"),
  // Anthropic 供应商逐模型声明 1M；存干净模型名，运行时再加 [1m] 并按需走本地转发。
  context1mModels: text("context_1m_models").notNull().default("[]"),
  // 多人模式:**不做共享池**,每人自带 API key(§八)。
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});
