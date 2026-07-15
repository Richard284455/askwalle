"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Input } from "@/ui/common/input";
import { Textarea } from "@/ui/common/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/common/select";
import { useToast } from "@/hooks/use-toast";
import type { AdminResourceRecord } from "@/lib/resources/resource-admin";

type ResourceTypeValue = "news" | "review" | "prompt" | "skill" | "tutorial";

const TYPE_OPTIONS: { value: ResourceTypeValue; label: string }[] = [
  { value: "news", label: "资讯 News" },
  { value: "review", label: "评测 Review" },
  { value: "prompt", label: "提示词 Prompt" },
  { value: "skill", label: "技能 Skill" },
  { value: "tutorial", label: "教程 Tutorial" },
];

const STATUS_OPTIONS = [
  { value: "draft", label: "草稿" },
  { value: "published", label: "发布" },
  { value: "archived", label: "归档" },
];

const SOURCE_TYPE_OPTIONS = [
  { value: "original", label: "原创 original" },
  { value: "source_informed", label: "来源参考 source_informed" },
  { value: "external", label: "外部 external" },
];

// 按类型的 content JSON 模板；字段与公开页解析逻辑
// （resource-content.ts 的 resourceContentToDetailItem）保持一致
const CONTENT_TEMPLATES: Record<ResourceTypeValue, Record<string, unknown>> = {
  news: {
    sourceName: "",
    sourceUrl: "",
    readTime: "3 min read",
    analysis: "",
    detailSections: [{ heading: "", body: "" }],
  },
  review: {
    sourceName: "",
    sourceUrl: "",
    rating: 4.5,
    bestFor: "",
    pros: [""],
    cons: [""],
    analysis: "",
    detailSections: [{ heading: "", body: "" }],
  },
  prompt: {
    difficulty: "Beginner",
    useCase: "",
    promptText: "",
    exampleInput: "",
    adaptationTips: [""],
    analysis: "",
    detailSections: [{ heading: "", body: "" }],
  },
  skill: {
    difficulty: "Beginner",
    estimatedTime: "",
    steps: [""],
    relatedTools: [""],
    outcome: "",
    analysis: "",
    detailSections: [{ heading: "", body: "" }],
  },
  tutorial: {
    level: "Beginner",
    estimatedTime: "",
    steps: [""],
    relatedTools: [""],
    outcome: "",
    analysis: "",
    detailSections: [{ heading: "", body: "" }],
  },
};

const SOURCES_TEMPLATE = [
  { title: "", url: "", publisher: "", accessedAt: "" },
];

function contentTemplateFor(type: ResourceTypeValue) {
  return JSON.stringify(CONTENT_TEMPLATES[type], null, 2);
}

function isUntouchedTemplate(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return Object.keys(CONTENT_TEMPLATES).some(
    (type) => contentTemplateFor(type as ResourceTypeValue) === trimmed
  );
}

export function ResourceForm({
  initialResource,
}: {
  initialResource?: AdminResourceRecord;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const isEdit = Boolean(initialResource);

  const [form, setForm] = useState({
    type: (initialResource?.type ?? "news") as ResourceTypeValue,
    slug: initialResource?.slug ?? "",
    title: initialResource?.title ?? "",
    summary: initialResource?.summary ?? "",
    category: initialResource?.category ?? "",
    tags: initialResource?.tags.join(", ") ?? "",
    publishedAt: (initialResource?.publishedAt ?? new Date().toISOString()).slice(
      0,
      16
    ),
    status: initialResource?.status ?? "draft",
    sourceType: initialResource?.sourceType ?? "original",
    content: initialResource?.content ?? contentTemplateFor("news"),
    sources: initialResource?.sources ?? "",
    seoTitle: initialResource?.seoTitle ?? "",
    seoDescription: initialResource?.seoDescription ?? "",
  });
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setField = (name: string, value: string) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleTypeChange = (value: string) => {
    const type = value as ResourceTypeValue;
    setForm((prev) => ({
      ...prev,
      type,
      // 新建且 content 未被手工修改时，切换类型自动套用对应模板
      content:
        !isEdit && isUntouchedTemplate(prev.content)
          ? contentTemplateFor(type)
          : prev.content,
    }));
  };

  const validateJson = (): boolean => {
    try {
      const content = JSON.parse(form.content);
      if (!content || typeof content !== "object" || Array.isArray(content)) {
        setJsonError("content 必须是 JSON 对象");
        return false;
      }
    } catch {
      setJsonError("content 不是合法的 JSON");
      return false;
    }

    if (form.sources.trim()) {
      try {
        const sources = JSON.parse(form.sources);
        if (!Array.isArray(sources)) {
          setJsonError("sources 必须是 JSON 数组");
          return false;
        }
      } catch {
        setJsonError("sources 不是合法的 JSON");
        return false;
      }
    }

    setJsonError(null);
    return true;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !validateJson()) return;

    setSaving(true);
    try {
      const payload = {
        type: form.type,
        slug: form.slug.trim(),
        title: form.title.trim(),
        summary: form.summary.trim(),
        category: form.category.trim(),
        tags: form.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        publishedAt: new Date(form.publishedAt).toISOString(),
        status: form.status,
        sourceType: form.sourceType,
        content: form.content,
        sources: form.sources,
        seoTitle: form.seoTitle,
        seoDescription: form.seoDescription,
      };

      const response = await fetch(
        isEdit ? `/api/resources/${initialResource!.id}` : "/api/resources",
        {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json().catch(() => null);

      if (response.ok && data?.success) {
        toast({
          title: isEdit ? "已保存" : "已创建",
          description: payload.title,
        });
        router.push("/admin/resources");
        router.refresh();
      } else {
        toast({
          title: "保存失败",
          description: data?.message || "请检查输入后重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "保存失败",
        description: "请检查输入后重试",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            {isEdit ? "编辑资源" : "新建资源"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isEdit
              ? `#${initialResource!.id} · ${initialResource!.slug}`
              : "创建资讯、评测、提示词、技能或教程内容"}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/resources" className="flex items-center gap-2">
            <ArrowLeft className="w-4 h-4" />
            返回列表
          </Link>
        </Button>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-5"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              类型
            </label>
            <Select value={form.type} onValueChange={handleTypeChange}>
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              状态
            </label>
            <Select
              value={form.status}
              onValueChange={(value) => setField("status", value)}
            >
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              来源类型
            </label>
            <Select
              value={form.sourceType}
              onValueChange={(value) => setField("sourceType", value)}
            >
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              标题
            </label>
            <Input
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              placeholder="资源标题"
              required
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              Slug
            </label>
            <Input
              value={form.slug}
              onChange={(e) => setField("slug", e.target.value)}
              placeholder="my-resource-slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="仅小写字母、数字和连字符"
              className="bg-background/40 border-border/40"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            摘要
          </label>
          <Textarea
            value={form.summary}
            onChange={(e) => setField("summary", e.target.value)}
            placeholder="一段简要说明，用于列表卡片展示"
            required
            rows={3}
            className="bg-background/40 border-border/40"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              分类
            </label>
            <Input
              value={form.category}
              onChange={(e) => setField("category", e.target.value)}
              placeholder="如 AI Coding"
              required
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              标签（逗号分隔）
            </label>
            <Input
              value={form.tags}
              onChange={(e) => setField("tags", e.target.value)}
              placeholder="tag1, tag2"
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              发布时间
            </label>
            <Input
              type="datetime-local"
              value={form.publishedAt}
              onChange={(e) => setField("publishedAt", e.target.value)}
              required
              className="bg-background/40 border-border/40"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            Content JSON（类型专属字段）
          </label>
          <Textarea
            value={form.content}
            onChange={(e) => setField("content", e.target.value)}
            rows={14}
            required
            spellCheck={false}
            className="bg-background/40 border-border/40 font-mono text-xs"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2 text-foreground/80">
            Sources JSON（可选，数组）
          </label>
          <Textarea
            value={form.sources}
            onChange={(e) => setField("sources", e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={JSON.stringify(SOURCES_TEMPLATE, null, 2)}
            className="bg-background/40 border-border/40 font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              SEO 标题（可选）
            </label>
            <Input
              value={form.seoTitle}
              onChange={(e) => setField("seoTitle", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-2 text-foreground/80">
              SEO 描述（可选）
            </label>
            <Input
              value={form.seoDescription}
              onChange={(e) => setField("seoDescription", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </div>
        </div>

        {jsonError && <p className="text-sm text-red-500">{jsonError}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" type="button" asChild>
            <Link href="/admin/resources">取消</Link>
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "保存中..." : isEdit ? "保存修改" : "创建资源"}
          </Button>
        </div>
      </form>
    </motion.div>
  );
}
