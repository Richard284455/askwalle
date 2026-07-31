/**
 * 标识符提取：**只做确定性 token 识别**。
 *
 * 明确不做：猜别名、查知识库、把普通名词当品牌、从正文抽实体。
 * 那些都需要外部知识，一旦引入，同一个标题在不同时间会得到不同结果，
 * 「可回放」就不成立了。
 */

/** 常见词即使带数字或大写也不算标识符 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "our", "new", "now", "how",
  "why", "what", "when", "all", "ai", "api", "app", "web", "you", "your",
  "a", "an", "of", "to", "in", "on", "at", "is", "are", "we", "it",
]);

/**
 * 识别四类：
 *   含数字的产品/模型 token（gpt-5、gemini2.5）
 *   版本号（v1.2.3）
 *   大写缩写（SDK、GPU；原始标题里大写才算）
 *   连字符标识符 / 包名（openai-python）
 */
export function extractEventIdentifiers(rawTitle: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!rawTitle || !rawTitle.trim()) return out;

  const normalized = rawTitle.normalize("NFKC");

  // 大写缩写：2–6 个连续大写字母，且不是常见词
  for (const m of normalized.matchAll(/\b[A-Z]{2,6}\b/g)) {
    const token = m[0].toLowerCase();
    if (!STOPWORDS.has(token)) out.add(token);
  }

  const lower = normalized.toLowerCase();

  // 版本号 v1.2.3 / v2
  for (const m of lower.matchAll(/\bv\d+(?:\.\d+)*\b/g)) out.add(m[0]);

  // 含数字的 token：gpt-5、gpt-5.6、gemini、claude 4 这类需要跟数字绑定
  for (const m of lower.matchAll(/\b([a-z][a-z0-9]*)[- ]?(\d+(?:\.\d+)*)\b/g)) {
    const name = m[1];
    if (STOPWORDS.has(name) || name.length < 2) continue;
    // 统一成 `name-number`，让「GPT-5」和「GPT 5」得到同一个标识符
    out.add(`${name}-${m[2]}`);
  }

  // 连字符标识符 / 包名：openai-python、flash-lite
  for (const m of lower.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g)) {
    const token = m[0];
    if (token.split("-").every((part) => STOPWORDS.has(part))) continue;
    out.add(token);
  }

  return out;
}
