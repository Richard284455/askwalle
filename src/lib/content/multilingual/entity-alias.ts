/**
 * 中英实体别名表。
 *
 * 为什么需要它：AI HOT 的转述语言是中文，而我们的母版是英文。
 * 来源写「谷歌」、母版写 "Google" —— 字面比对会把这判成「文章引入了来源
 * 没有的实体」，于是**每一篇**稿子都会因为这类误报被拦下，闸门随即失去意义。
 *
 * 为什么是写死的表而不是模型判断：实体等价必须可审计、可复现。
 * 让模型来判「Google 是不是谷歌」，等于把同一类错误再犯一次。
 *
 * 表只收 AI 领域里高频、且映射无歧义的机构与产品名。
 * 收不进来的（人名音译、新公司）会走「逐词回退」，实在不匹配就报出来给人看 ——
 * 宁可让人多看一眼，也不要静默放过一个真的被编出来的实体。
 */

const ALIAS_GROUPS: string[][] = [
  ["Google", "谷歌"],
  ["Google DeepMind", "谷歌 DeepMind", "谷歌DeepMind"],
  ["DeepMind", "深度思维"],
  ["OpenAI", "开放人工智能"],
  ["Microsoft", "微软"],
  ["Nvidia", "NVIDIA", "英伟达"],
  ["Meta", "元宇宙平台"],
  ["Apple", "苹果"],
  ["Amazon", "亚马逊"],
  ["Amazon Web Services", "AWS", "亚马逊云科技"],
  ["Alibaba", "阿里巴巴", "阿里"],
  ["Alibaba Cloud", "阿里云"],
  ["Tencent", "腾讯"],
  ["Baidu", "百度"],
  ["ByteDance", "字节跳动", "字节"],
  ["Huawei", "华为"],
  ["DeepSeek", "深度求索"],
  ["Moonshot AI", "月之暗面"],
  ["Zhipu AI", "智谱", "智谱AI"],
  ["MiniMax", "稀宇科技"],
  ["SiliconFlow", "硅基流动"],
  ["Anthropic"],
  ["Hugging Face", "抱抱脸"],
  ["Stability AI"],
  ["Mistral AI", "Mistral"],
  ["Intel", "英特尔"],
  ["AMD", "超威"],
  ["Qualcomm", "高通"],
  ["Samsung", "三星"],
  ["Tesla", "特斯拉"],
  ["xAI"],
  ["IBM", "国际商业机器"],
  ["Oracle", "甲骨文"],
  ["Salesforce"],
  ["Adobe"],
  ["Netflix", "奈飞"],
  ["Reddit"],
  ["GitHub"],
  ["Stack Overflow"],
  ["Hacker News"],
  ["United States", "美国"],
  ["China", "中国"],
  ["European Union", "欧盟"],
  ["United Kingdom", "英国"],
  ["Japan", "日本"],
  ["South Korea", "韩国"],
  ["India", "印度"],
  ["Department of Energy", "能源部"],
  ["White House", "白宫"],
  ["Nature", "自然杂志"],
  ["Science", "科学杂志"],
  ["arXiv"],
  ["Transformer", "变换器"],
  /*
   * 中文科技媒体。AI HOT 的来源名是中文，母版会把它们译成英文；
   * 不登记的话，「IT之家」→ "IT Home" 会被判成凭空冒出来的机构。
   * 首轮 canary 实测到的就是这一类。
   */
  ["IT Home", "IT之家"],
  ["Synced", "机器之心"],
  ["QbitAI", "量子位"],
  ["AI Era", "新智元"],
  ["Jiqizhixin", "机器之心"],
  ["MarkTechPost"],
  // 中国政府机构的通行英文名。日报里出现过「国家发改委 → NDRC」
  ["NDRC", "国家发改委", "国家发展和改革委员会", "National Development and Reform Commission"],
  ["MIIT", "工信部", "工业和信息化部"],
  ["CAC", "网信办", "国家互联网信息办公室"],
  ["ModelBest", "面壁智能", "面壁"],
  ["Tsinghua", "清华", "清华大学"],
  ["Peking University", "北京大学", "北大"],
  ["LangChain"],
  ["Simon Willison"],
];

function key(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 别名 → 该组所有写法。用于「母版里的 X 是否等价于来源里的某个词」 */
const ALIAS_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of ALIAS_GROUPS) {
    for (const name of group) {
      const k = key(name);
      m.set(k, [...(m.get(k) ?? []), ...group]);
    }
  }
  return m;
})();

/** 取某个名字的全部等价写法（含自身）。没有登记的返回只含自身的数组 */
export function aliasesOf(name: string): string[] {
  return ALIAS_INDEX.get(key(name)) ?? [name];
}

/**
 * `name` 是否以某种等价写法出现在 `corpusNorm` 里。
 * corpusNorm 必须是已经用同一套规则归一化过的语料。
 */
export function entityPresent(name: string, corpusNorm: string): boolean {
  return aliasesOf(name).some((a) => corpusNorm.includes(key(a)));
}

export function normalizeForEntityMatch(s: string): string {
  return key(s);
}

/** 别名表规模，供测试与报告核对 */
export const ALIAS_GROUP_COUNT = ALIAS_GROUPS.length;
