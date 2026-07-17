import { Prisma, type AIProviderConfig } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  decryptCredential,
  encryptCredential,
  hasCredentialMasterKey,
  MISSING_MASTER_KEY_MESSAGE,
} from "@/lib/security/credential-crypto";

// ---------------------------------------------------------------------------
// 静态注册表（内置默认值；DB 配置可覆盖 baseUrl / 默认模型 / enabled / presets）
// ---------------------------------------------------------------------------

export type ProviderKey = "openai" | "deepseek" | "qwen" | "kimi" | "custom";

type StaticProvider = {
  label: string;
  defaultBaseUrl: string;
  envKeys: string[];
  defaultModel: string;
  mode: "batch" | "direct";
  supportsJsonSchema: boolean;
};

const STATIC_PROVIDERS: Record<ProviderKey, StaticProvider> = {
  openai: {
    label: "OpenAI (Batch API)",
    defaultBaseUrl: "https://api.openai.com/v1",
    envKeys: ["OPENAI_API_KEY"],
    defaultModel: "gpt-4o-mini",
    mode: "batch",
    supportsJsonSchema: true,
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    envKeys: ["DEEPSEEK_API_KEY"],
    defaultModel: "deepseek-chat",
    mode: "direct",
    supportsJsonSchema: false,
  },
  qwen: {
    label: "Qwen (DashScope 兼容模式)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKeys: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    defaultModel: "qwen-plus",
    mode: "direct",
    supportsJsonSchema: false,
  },
  kimi: {
    label: "Kimi (Moonshot)",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    envKeys: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    defaultModel: "moonshot-v1-8k",
    mode: "direct",
    supportsJsonSchema: false,
  },
  custom: {
    label: "自定义 OpenAI 兼容端点",
    defaultBaseUrl: process.env.REWRITE_BASE_URL || "",
    envKeys: ["REWRITE_API_KEY"],
    defaultModel: process.env.REWRITE_MODEL || "",
    mode: "direct",
    supportsJsonSchema: false,
  },
};

export const PROVIDER_KEYS = Object.keys(STATIC_PROVIDERS) as ProviderKey[];

export function isProviderKey(value: string): value is ProviderKey {
  return value in STATIC_PROVIDERS;
}

export function providerMode(providerKey: string): "batch" | "direct" {
  return isProviderKey(providerKey)
    ? STATIC_PROVIDERS[providerKey].mode
    : "direct";
}

function envApiKey(providerKey: ProviderKey): string | null {
  for (const env of STATIC_PROVIDERS[providerKey].envKeys) {
    const value = process.env[env];
    if (value) return value;
  }
  return null;
}

function presetsFromJson(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

// ---------------------------------------------------------------------------
// 设置视图（提供给后台 UI；绝不包含 key 明文/密文）
// ---------------------------------------------------------------------------

export type ProviderSettingsView = {
  providerKey: ProviderKey;
  displayName: string;
  enabled: boolean;
  baseUrl: string;
  defaultBaseUrl: string;
  keyStatus: "configured" | "missing";
  keySource: "env" | "db" | "missing";
  keyLast4: string | null;
  keyEnv: string;
  defaultModel: string;
  modelPresets: string[];
  mode: "batch" | "direct";
  supportsBatch: boolean;
  supportsDirect: boolean;
  supportsJsonSchema: boolean;
  notes: string;
  lastTestedAt: string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
  updatedAt: string | null;
  masterKeyConfigured: boolean;
};

function toView(
  providerKey: ProviderKey,
  config: AIProviderConfig | null
): ProviderSettingsView {
  const staticInfo = STATIC_PROVIDERS[providerKey];
  const envKey = envApiKey(providerKey);
  const dbKeyConfigured = Boolean(config?.encrypted_api_key);
  const keySource: "env" | "db" | "missing" = envKey
    ? "env"
    : dbKeyConfigured
    ? "db"
    : "missing";

  return {
    providerKey,
    displayName: config?.display_name || staticInfo.label,
    enabled: config?.enabled ?? true,
    baseUrl: config?.base_url || staticInfo.defaultBaseUrl,
    defaultBaseUrl: staticInfo.defaultBaseUrl,
    keyStatus: keySource === "missing" ? "missing" : "configured",
    keySource,
    keyLast4:
      keySource === "env"
        ? envKey!.slice(-4)
        : keySource === "db"
        ? config?.api_key_last4 ?? null
        : null,
    keyEnv: staticInfo.envKeys[0],
    defaultModel: config?.default_model || staticInfo.defaultModel,
    modelPresets: presetsFromJson(config?.model_presets),
    mode: staticInfo.mode,
    supportsBatch: config?.supports_batch ?? staticInfo.mode === "batch",
    supportsDirect: config?.supports_direct ?? true,
    supportsJsonSchema:
      config?.supports_json_schema ?? staticInfo.supportsJsonSchema,
    notes: config?.notes ?? "",
    lastTestedAt: config?.last_tested_at?.toISOString() ?? null,
    lastTestStatus: config?.last_test_status ?? null,
    lastTestError: config?.last_test_error ?? null,
    updatedAt: config?.updated_at?.toISOString() ?? null,
    masterKeyConfigured: hasCredentialMasterKey(),
  };
}

export async function getProviderSettings(): Promise<ProviderSettingsView[]> {
  const configs = await prisma.aIProviderConfig.findMany();
  const byKey = new Map(configs.map((config) => [config.provider_key, config]));
  return PROVIDER_KEYS.map((providerKey) =>
    toView(providerKey, byKey.get(providerKey) ?? null)
  );
}

export async function getProviderSetting(
  providerKey: ProviderKey
): Promise<ProviderSettingsView> {
  const config = await prisma.aIProviderConfig.findUnique({
    where: { provider_key: providerKey },
  });
  return toView(providerKey, config);
}

// ---------------------------------------------------------------------------
// 保存配置（key 只加密入库；缺 master key 时拒绝）
// ---------------------------------------------------------------------------

export type SaveProviderInput = {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  defaultModel?: string;
  modelPresets?: string[];
  notes?: string;
  displayName?: string;
};

export async function saveProviderConfig(
  providerKey: ProviderKey,
  input: SaveProviderInput
): Promise<{ ok: true } | { ok: false; message: string }> {
  const data: Prisma.AIProviderConfigUncheckedCreateInput = {
    provider_key: providerKey,
  };

  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.displayName !== undefined) {
    data.display_name = input.displayName.trim() || null;
  }
  if (input.baseUrl !== undefined) {
    const trimmed = input.baseUrl.trim();
    if (trimmed && !/^https?:\/\//.test(trimmed)) {
      return { ok: false, message: "base URL 必须以 http(s):// 开头" };
    }
    data.base_url = trimmed || null;
  }
  if (input.defaultModel !== undefined) {
    data.default_model = input.defaultModel.trim() || null;
  }
  if (input.modelPresets !== undefined) {
    const presets = input.modelPresets
      .map((preset) => preset.trim())
      .filter(Boolean);
    data.model_presets = presets as Prisma.InputJsonValue;
  }
  if (input.notes !== undefined) data.notes = input.notes.trim() || null;

  if (input.clearApiKey) {
    data.encrypted_api_key = null;
    data.api_key_last4 = null;
    data.api_key_source = null;
  } else if (input.apiKey !== undefined && input.apiKey.trim()) {
    if (!hasCredentialMasterKey()) {
      return { ok: false, message: MISSING_MASTER_KEY_MESSAGE };
    }
    const apiKey = input.apiKey.trim();
    const encrypted = encryptCredential(apiKey);
    if (!encrypted.ok) return encrypted;
    data.encrypted_api_key = encrypted.ciphertext;
    data.api_key_last4 = apiKey.slice(-4);
    data.api_key_source = "db";
  }

  const { provider_key: _pk, ...updateData } = data;
  void _pk;
  await prisma.aIProviderConfig.upsert({
    where: { provider_key: providerKey },
    update: updateData,
    create: data,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 运行时解析（env 优先于 DB；解密只发生在服务端调用点）
// ---------------------------------------------------------------------------

export type ProviderRuntime =
  | {
      ok: true;
      baseUrl: string;
      apiKey: string;
      model: string;
      source: "env" | "db";
      enabled: boolean;
    }
  | { ok: false; message: string };

export async function resolveProviderRuntime(
  providerKey: ProviderKey,
  modelOverride?: string
): Promise<ProviderRuntime> {
  const config = await prisma.aIProviderConfig.findUnique({
    where: { provider_key: providerKey },
  });
  const staticInfo = STATIC_PROVIDERS[providerKey];

  const baseUrl = (config?.base_url || staticInfo.defaultBaseUrl).replace(/\/$/, "");
  if (!baseUrl) {
    return { ok: false, message: `${providerKey} 未配置 base URL` };
  }

  const envKey = envApiKey(providerKey);
  let apiKey: string | null = envKey;
  let source: "env" | "db" = "env";
  if (!apiKey && config?.encrypted_api_key) {
    apiKey = decryptCredential(config.encrypted_api_key);
    source = "db";
    if (!apiKey) {
      return {
        ok: false,
        message:
          "无法解密已保存的 API key（AI_PROVIDER_CREDENTIAL_KEY 缺失或已变更）",
      };
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      message: `Missing ${staticInfo.envKeys[0]}（或在 AI Provider 配置中心保存 key）`,
    };
  }

  const model =
    modelOverride?.trim() ||
    config?.default_model ||
    process.env[`REWRITE_MODEL_${providerKey.toUpperCase()}`] ||
    (providerKey === "openai" ? process.env.OPENAI_REWRITE_MODEL : undefined) ||
    staticInfo.defaultModel;
  if (!model) {
    return { ok: false, message: `${providerKey} 未配置模型 ID` };
  }

  return {
    ok: true,
    baseUrl,
    apiKey,
    model,
    source,
    enabled: config?.enabled ?? true,
  };
}

// ---------------------------------------------------------------------------
// 连接测试与模型同步（轻量请求；不输出 key，不写完整 headers）
// ---------------------------------------------------------------------------

function safeErrorSummary(status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: { message?: string } }).error;
    if (error?.message) return `HTTP ${status}: ${error.message.slice(0, 180)}`;
  }
  return `HTTP ${status}`;
}

export async function testProviderConnection(
  providerKey: ProviderKey
): Promise<{ ok: boolean; message: string }> {
  const runtime = await resolveProviderRuntime(providerKey);
  if (!runtime.ok) return { ok: false, message: runtime.message };

  let status = "failed";
  let errorSummary: string | null = null;
  try {
    const response = await fetch(`${runtime.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` },
    });
    if (response.ok) {
      status = "ok";
    } else {
      const body = await response.json().catch(() => null);
      errorSummary = safeErrorSummary(response.status, body);
    }
  } catch (error) {
    errorSummary =
      error instanceof Error ? error.message.slice(0, 180) : "请求失败";
  }

  await prisma.aIProviderConfig.upsert({
    where: { provider_key: providerKey },
    update: {
      last_tested_at: new Date(),
      last_test_status: status,
      last_test_error: errorSummary,
    },
    create: {
      provider_key: providerKey,
      last_tested_at: new Date(),
      last_test_status: status,
      last_test_error: errorSummary,
    },
  });

  return status === "ok"
    ? { ok: true, message: "连接成功" }
    : { ok: false, message: errorSummary ?? "连接失败" };
}

export async function syncProviderModels(
  providerKey: ProviderKey
): Promise<{ ok: boolean; message: string; count?: number }> {
  const runtime = await resolveProviderRuntime(providerKey);
  if (!runtime.ok) return { ok: false, message: runtime.message };

  try {
    const response = await fetch(`${runtime.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${runtime.apiKey}` },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return {
        ok: false,
        message: `同步失败: ${safeErrorSummary(response.status, body)}（已保留手动 presets）`,
      };
    }
    const body = (await response.json()) as { data?: { id?: string }[] };
    const models = Array.isArray(body.data)
      ? body.data
          .map((entry) => entry?.id)
          .filter((id): id is string => typeof id === "string")
          .sort()
      : [];
    if (!models.length) {
      return { ok: false, message: "该端点未返回模型列表（已保留手动 presets）" };
    }
    await prisma.aIProviderConfig.upsert({
      where: { provider_key: providerKey },
      update: { model_presets: models as Prisma.InputJsonValue },
      create: {
        provider_key: providerKey,
        model_presets: models as Prisma.InputJsonValue,
      },
    });
    return { ok: true, message: `已同步 ${models.length} 个模型`, count: models.length };
  } catch (error) {
    return {
      ok: false,
      message: `同步失败: ${error instanceof Error ? error.message.slice(0, 120) : "请求异常"}（已保留手动 presets）`,
    };
  }
}
