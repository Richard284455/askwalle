import { prisma } from "@/lib/prisma";
import {
  getProviderSettings, isProviderKey, type ProviderKey,
} from "@/lib/website/ai-provider-config";

/**
 * Newsroom（AI HOT 三个板块）用哪个模型。
 *
 * 这条链路做三件需要大模型的事，**全部用同一个模型**：
 *   1. 英文母版改写（把 AI HOT 的中文材料重写成英文原创资讯）
 *   2. es-ES / pt-BR / ja-JP 三种译文
 *   3. 热点简报与日报的摘要撰写
 *
 * 刻意不做「母版用 A、翻译用 B」的分模型配置：翻译漂移的判定基准是母版，
 * 两端换模型会让「这处差异是翻译问题还是模型差异」再也说不清。
 *
 * 忠实度 QA **不用模型** —— 那是确定性比对（数字/日期/型号/实体），
 * 换模型不影响它，也不该影响它。
 */

const SETTING_KEY = "aihot:newsroom-model";

/** 没配置时的兜底。改这里等于改所有未显式配置环境的默认行为 */
export const DEFAULT_NEWSROOM_PROVIDER: ProviderKey = "deepseek";

export type NewsroomModel = {
  provider: ProviderKey;
  /** null 表示用该 provider 自己的 default_model */
  model: string | null;
};

export type NewsroomModelResolution = NewsroomModel & {
  source: "setting" | "default";
  /** 该 provider 当前是否可用（已启用且有可解析的密钥） */
  available: boolean;
  /** 不可用时的说明；可用时为 null */
  unavailableReason: string | null;
};

function parse(raw: string | null | undefined): NewsroomModel | null {
  if (!raw?.trim()) return null;
  try {
    const v = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    if (typeof v.provider !== "string" || !isProviderKey(v.provider)) return null;
    return { provider: v.provider, model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : null };
  } catch {
    return null;
  }
}

/**
 * 解析当前生效的模型。
 *
 * **不会因为 provider 不可用就自动换一个。** 悄悄换模型意味着某天的稿子
 * 是另一个模型写的，而审计里看不出任何痕迹 —— 宁可如实报告不可用，
 * 让生成失败并留下记录。
 */
export async function resolveNewsroomModel(): Promise<NewsroomModelResolution> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  const parsed = parse(row?.value);
  const chosen: NewsroomModel = parsed ?? { provider: DEFAULT_NEWSROOM_PROVIDER, model: null };

  const providers = await getProviderSettings().catch(() => []);
  const cfg = providers.find((p) => p.providerKey === chosen.provider);
  const available = Boolean(cfg?.enabled && cfg?.keyStatus === "configured");
  const unavailableReason = available
    ? null
    : !cfg ? `未知的 provider：${chosen.provider}`
    : !cfg.enabled ? `${cfg.displayName} 当前处于停用状态`
    : `${cfg.displayName} 没有可用的 API 密钥（${cfg.keyEnv}）`;

  return {
    ...chosen,
    source: parsed ? "setting" : "default",
    available,
    unavailableReason,
  };
}

export type SaveResult = { ok: true; saved: NewsroomModel } | { ok: false; reason: string };

/**
 * 保存选择。
 *
 * 会校验 provider 存在且已启用 —— 存一个用不了的组合，故障会推迟到
 * 下一次定时生成时才出现，而那时没人在看。
 */
export async function saveNewsroomModel(input: { provider: string; model?: string | null }): Promise<SaveResult> {
  if (!isProviderKey(input.provider)) return { ok: false, reason: `未知的 provider：${input.provider}` };

  const providers = await getProviderSettings().catch(() => []);
  const cfg = providers.find((p) => p.providerKey === input.provider);
  if (!cfg) return { ok: false, reason: `未找到 ${input.provider} 的配置` };
  if (!cfg.enabled) return { ok: false, reason: `${cfg.displayName} 当前处于停用状态，请先在「AI 服务商」里启用` };
  if (cfg.keyStatus !== "configured") return { ok: false, reason: `${cfg.displayName} 没有可用的 API 密钥，请先配置` };

  const model = input.model?.trim() || null;
  /*
   * 模型 ID 只在「该 provider 已登记过」时校验。
   * 硬性要求必须在预设列表里会挡住刚发布的新模型 —— 那种时候人是对的，
   * 列表是旧的。这里只在明确不认识时提示，不阻断。
   */
  const known = [cfg.defaultModel, ...(cfg.modelPresets ?? [])].filter(Boolean) as string[];
  if (model && known.length && !known.includes(model)) {
    // 允许，但把「这个模型不在已登记列表里」如实记下来
    console.warn(`[newsroom-model] ${input.provider} 的模型 ${model} 不在已登记列表中，仍按配置保存`);
  }

  const value = JSON.stringify({ provider: input.provider, model });
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value },
    update: { value },
  });
  return { ok: true, saved: { provider: input.provider, model } };
}

/** 可选项：给后台下拉用。不可用的 provider 也返回，但标出原因 */
export async function newsroomModelOptions() {
  const providers = await getProviderSettings().catch(() => []);
  return providers.map((p) => ({
    providerKey: p.providerKey,
    displayName: p.displayName,
    enabled: p.enabled,
    hasApiKey: p.keyStatus === "configured",
    keySource: p.keySource,
    defaultModel: p.defaultModel,
    models: [...new Set([p.defaultModel, ...(p.modelPresets ?? [])].filter(Boolean))] as string[],
  }));
}
