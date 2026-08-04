import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

export const effortSettingSchema = z.enum([
  "auto",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const promptCacheCompatSchema = z.object({
  cacheControlFormat: z.literal("anthropic").optional(),
  promptCacheSessionHeader: z.literal("x-grok-conv-id").optional(),
  supportsPromptCacheBreakpoints: z.boolean().optional(),
  promptCacheBreakpointTtl: z.literal("30m").optional(),
  supportsLongPromptCacheRetention: z.boolean().optional(),
});

export const customModelSchema = z.object({
  id: nonEmptyString,
  contextWindow: positiveInteger,
  maxOutputTokens: positiveInteger,
  input: z.array(z.enum(["text", "image"])).min(1),
  toolCalling: z.boolean(),
  reasoning: z.boolean().optional(),
  name: nonEmptyString.optional(),
  compat: promptCacheCompatSchema.optional(),
});

export const customProviderSchema = z.object({
  type: z.literal("openai-compatible"),
  baseUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  }, "URL must not contain inline credentials"),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name")
    .optional(),
  keyless: z.boolean().optional(),
  api: z.enum(["openai-completions", "openai-responses"]).optional(),
  models: z.array(customModelSchema).min(1),
});

export const configSchema = z.object({
  defaultModel: nonEmptyString.optional(),
  defaultSubtaskModel: nonEmptyString.optional(),
  effort: effortSettingSchema.default("auto"),
  subtaskEffort: effortSettingSchema.default("auto"),
  permissionMode: z.enum(["safe", "write", "yolo"]).default("write"),
  maxSubagents: nonNegativeInteger.default(3),
  maxSubagentDepth: nonNegativeInteger.default(1),
  compaction: z
    .object({
      enabled: z.boolean().default(true),
      thresholdPercent: z.number().int().min(1).max(100).default(85),
      keepRecentTokens: positiveInteger.default(20_000),
    })
    .default({ enabled: true, thresholdPercent: 85, keepRecentTokens: 20_000 }),
  ui: z
    .object({
      theme: z.enum(["default", "high-contrast"]).default("default"),
      showThinking: z.boolean().default(false),
    })
    .default({ theme: "default", showThinking: false }),
  providers: z.record(nonEmptyString, customProviderSchema).default({}),
});

const customProviderLayerSchema = z.object({
  type: z.literal("openai-compatible").optional(),
  baseUrl: customProviderSchema.shape.baseUrl.optional(),
  apiKeyEnv: customProviderSchema.shape.apiKeyEnv,
  keyless: customProviderSchema.shape.keyless,
  api: customProviderSchema.shape.api,
  models: customProviderSchema.shape.models.optional(),
});

export const configLayerSchema = z.object({
  defaultModel: configSchema.shape.defaultModel,
  defaultSubtaskModel: configSchema.shape.defaultSubtaskModel,
  effort: effortSettingSchema.optional(),
  subtaskEffort: effortSettingSchema.optional(),
  permissionMode: z.enum(["safe", "write", "yolo"]).optional(),
  maxSubagents: nonNegativeInteger.optional(),
  maxSubagentDepth: nonNegativeInteger.optional(),
  compaction: z
    .object({
      enabled: z.boolean().optional(),
      thresholdPercent: z.number().int().min(1).max(100).optional(),
      keepRecentTokens: positiveInteger.optional(),
    })
    .optional(),
  ui: z
    .object({
      theme: z.enum(["default", "high-contrast"]).optional(),
      showThinking: z.boolean().optional(),
    })
    .optional(),
  providers: z.record(nonEmptyString, customProviderLayerSchema).optional(),
});

export type CustomModelConfig = z.infer<typeof customModelSchema>;
export type CustomProviderConfig = z.infer<typeof customProviderSchema>;
export type BriskConfig = z.infer<typeof configSchema>;
export type EffortSetting = z.infer<typeof effortSettingSchema>;
export type ConfigOverrides = z.infer<typeof configLayerSchema>;

export const DEFAULT_CONFIG: BriskConfig = configSchema.parse({});
