"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ArrowLeft, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
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
import { cn } from "@/lib/utils/utils";
import type {
  AdminCategoryOption,
  AdminToolFaq,
  AdminToolRecord,
} from "@/lib/website/tool-admin";

const STATUS_OPTIONS = [
  { value: "pending", label: "待审核 pending" },
  { value: "approved", label: "已发布 approved" },
  { value: "rejected", label: "已拒绝 rejected" },
  { value: "archived", label: "已归档 archived" },
];

const LINKS_PLACEHOLDER = `[
  { "kind": "pricing", "url": "https://example.com/pricing" },
  { "kind": "twitter", "url": "https://twitter.com/example" },
  { "kind": "email", "url": "hi@example.com" }
]`;

const MEDIA_PLACEHOLDER = `[
  { "url": "/cached-tool-media/tool-1-media-1.jpg", "alt": "Screenshot" }
]`;

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium mb-2 text-foreground/80">
        {label}
      </label>
      {children}
    </div>
  );
}

export function ToolEditForm({
  initialTool,
  categories,
}: {
  initialTool: AdminToolRecord;
  categories: AdminCategoryOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [form, setForm] = useState({
    title: initialTool.title,
    slug: initialTool.slug,
    url: initialTool.url,
    description: initialTool.description,
    categoryId: initialTool.categoryId.toString(),
    status: initialTool.status,
    what: initialTool.detail.what,
    how: initialTool.detail.how,
    featuresText: initialTool.detail.featuresText,
    features: initialTool.detail.features,
    useCases: initialTool.detail.useCases,
    rating:
      initialTool.detail.rating !== null
        ? String(initialTool.detail.rating)
        : "",
    reviewCount: String(initialTool.detail.reviewCount),
    savedCount: String(initialTool.detail.savedCount),
    monthlyVisitors:
      initialTool.detail.monthlyVisitors !== null
        ? String(initialTool.detail.monthlyVisitors)
        : "",
    listedAt: initialTool.detail.listedAt,
    source: initialTool.detail.source,
    externalRaw: initialTool.detail.externalRaw,
    tagsPlatform: initialTool.tags.platform,
    tagsPricing: initialTool.tags.pricing,
    tagsTopic: initialTool.tags.topic,
    links: initialTool.links,
    media: initialTool.media,
  });
  const [faqs, setFaqs] = useState<AdminToolFaq[]>(initialTool.faqs);
  const [saving, setSaving] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(initialTool.status);

  const setField = (name: string, value: string) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const parseNumberField = (
    value: string,
    label: string,
    options: { integer?: boolean; nullable?: boolean }
  ): number | null | undefined => {
    if (!value.trim()) {
      if (options.nullable) return null;
      return 0;
    }
    const parsed = options.integer ? parseInt(value, 10) : parseFloat(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      toast({
        title: "输入无效",
        description: `${label} 必须是非负数字`,
        variant: "destructive",
      });
      return undefined;
    }
    return parsed;
  };

  const handleSave = async () => {
    if (saving) return;

    const rating = parseNumberField(form.rating, "rating", { nullable: true });
    if (rating === undefined) return;
    const reviewCount = parseNumberField(form.reviewCount, "review_count", {
      integer: true,
    });
    if (reviewCount === undefined) return;
    const savedCount = parseNumberField(form.savedCount, "saved_count", {
      integer: true,
    });
    if (savedCount === undefined) return;
    const monthlyVisitors = parseNumberField(
      form.monthlyVisitors,
      "monthly_visitors",
      { integer: true, nullable: true }
    );
    if (monthlyVisitors === undefined) return;

    // JSON 字段客户端预检，服务端仍是最终校验
    for (const [field, value] of [
      ["features", form.features],
      ["use_cases", form.useCases],
      ["links", form.links],
      ["media", form.media],
    ] as const) {
      if (value.trim()) {
        try {
          JSON.parse(value);
        } catch {
          toast({
            title: "JSON 无效",
            description: `${field} 不是合法的 JSON`,
            variant: "destructive",
          });
          return;
        }
      }
    }

    setSaving(true);
    try {
      const payload = {
        title: form.title,
        slug: form.slug.trim(),
        url: form.url.trim(),
        description: form.description,
        categoryId: parseInt(form.categoryId, 10),
        status: form.status,
        detail: {
          what: form.what,
          how: form.how,
          featuresText: form.featuresText,
          features: form.features,
          useCases: form.useCases,
          rating,
          reviewCount: reviewCount ?? 0,
          savedCount: savedCount ?? 0,
          monthlyVisitors,
          listedAt: form.listedAt,
          source: form.source,
          externalRaw: form.externalRaw,
        },
        tags: {
          platform: form.tagsPlatform,
          pricing: form.tagsPricing,
          topic: form.tagsTopic,
        },
        links: form.links,
        media: form.media,
        faqs: faqs.filter((faq) => faq.question.trim()),
      };

      const response = await fetch(`/api/admin/tools/${initialTool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => null);

      if (response.ok && data?.code === 200) {
        setCurrentStatus(form.status);
        toast({ title: "已保存", description: form.title });
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

  const handleQuickStatus = async (status: string, successLabel: string) => {
    if (statusPending) return;
    setStatusPending(true);
    try {
      const response = await fetch(`/api/websites/${initialTool.id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.code === 200) {
        setCurrentStatus(status);
        setField("status", status);
        toast({ title: successLabel, description: initialTool.title });
        router.refresh();
      } else {
        toast({
          title: "操作失败",
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "操作失败", description: "请重试", variant: "destructive" });
    } finally {
      setStatusPending(false);
    }
  };

  const updateFaq = (index: number, patch: Partial<AdminToolFaq>) => {
    setFaqs((prev) =>
      prev.map((faq, i) => (i === index ? { ...faq, ...patch } : faq))
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
              编辑工具
            </h1>
            <Badge
              variant="outline"
              className={cn(
                "px-2 py-0.5",
                currentStatus === "approved"
                  ? "border-green-500/30 text-green-600 dark:text-green-400"
                  : currentStatus === "pending"
                  ? "border-yellow-500/30 text-yellow-600 dark:text-yellow-400"
                  : "text-muted-foreground"
              )}
            >
              {currentStatus}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            #{initialTool.id} · {initialTool.title}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {currentStatus === "approved" && form.slug && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/tools/${form.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2"
              >
                <ExternalLink className="w-4 h-4" />
                View public page
              </a>
            </Button>
          )}
          {currentStatus !== "approved" && (
            <Button
              size="sm"
              disabled={statusPending}
              onClick={() => handleQuickStatus("approved", "已发布")}
            >
              发布
            </Button>
          )}
          {currentStatus === "approved" && (
            <Button
              variant="outline"
              size="sm"
              disabled={statusPending}
              onClick={() => handleQuickStatus("pending", "已退回待审核")}
            >
              退回待审核
            </Button>
          )}
          {currentStatus !== "archived" && (
            <Button
              variant="outline"
              size="sm"
              disabled={statusPending}
              onClick={() => handleQuickStatus("archived", "已归档")}
              className="text-red-500 hover:text-red-600"
            >
              归档
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/tools" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回列表
            </Link>
          </Button>
        </div>
      </div>

      <SectionCard title="基础信息" description="Website 基础字段">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="标题">
            <Input
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="Slug">
            <Input
              value={form.slug}
              onChange={(e) => setField("slug", e.target.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="仅小写字母、数字和连字符"
              className="bg-background/40 border-border/40"
            />
          </Field>
        </div>
        <Field label="官网 URL">
          <Input
            value={form.url}
            onChange={(e) => setField("url", e.target.value)}
            className="bg-background/40 border-border/40"
          />
        </Field>
        <Field label="描述">
          <Textarea
            value={form.description}
            onChange={(e) => setField("description", e.target.value)}
            rows={3}
            className="bg-background/40 border-border/40"
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="分类">
            <Select
              value={form.categoryId}
              onValueChange={(value) => setField("categoryId", value)}
            >
              <SelectTrigger className="bg-background/40 border-border/40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="状态（随保存一起提交）">
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
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title="详情内容"
        description="ToolDetail 字段；来源文本请审核/改写后再发布"
      >
        <Field label="What（介绍正文）">
          <Textarea
            value={form.what}
            onChange={(e) => setField("what", e.target.value)}
            rows={5}
            className="bg-background/40 border-border/40"
          />
        </Field>
        <Field label="How（使用说明正文）">
          <Textarea
            value={form.how}
            onChange={(e) => setField("how", e.target.value)}
            rows={5}
            className="bg-background/40 border-border/40"
          />
        </Field>
        <Field label="Features 文本（无法拆分时的段落形式）">
          <Textarea
            value={form.featuresText}
            onChange={(e) => setField("featuresText", e.target.value)}
            rows={4}
            className="bg-background/40 border-border/40"
          />
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label='Features JSON（字符串数组，如 ["A","B"]，留空则不用列表）'>
            <Textarea
              value={form.features}
              onChange={(e) => setField("features", e.target.value)}
              rows={6}
              spellCheck={false}
              className="bg-background/40 border-border/40 font-mono text-xs"
            />
          </Field>
          <Field label="Use cases JSON（字符串数组）">
            <Textarea
              value={form.useCases}
              onChange={(e) => setField("useCases", e.target.value)}
              rows={6}
              spellCheck={false}
              className="bg-background/40 border-border/40 font-mono text-xs"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Field label="Rating (0-5)">
            <Input
              value={form.rating}
              onChange={(e) => setField("rating", e.target.value)}
              placeholder="留空为无"
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="Reviews">
            <Input
              value={form.reviewCount}
              onChange={(e) => setField("reviewCount", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="Saved">
            <Input
              value={form.savedCount}
              onChange={(e) => setField("savedCount", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="月访问量">
            <Input
              value={form.monthlyVisitors}
              onChange={(e) => setField("monthlyVisitors", e.target.value)}
              placeholder="留空为无"
              className="bg-background/40 border-border/40"
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="收录日期">
            <Input
              type="date"
              value={form.listedAt}
              onChange={(e) => setField("listedAt", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="来源标识 source">
            <Input
              value={form.source}
              onChange={(e) => setField("source", e.target.value)}
              className="bg-background/40 border-border/40"
            />
          </Field>
        </div>
        <Field label="External 原文（内部参考，不公开渲染）">
          <Textarea
            value={form.externalRaw}
            onChange={(e) => setField("externalRaw", e.target.value)}
            rows={4}
            className="bg-background/40 border-border/40 text-xs"
          />
        </Field>
      </SectionCard>

      <SectionCard title="标签" description="逗号分隔；保存时整体替换">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Field label="Platform">
            <Input
              value={form.tagsPlatform}
              onChange={(e) => setField("tagsPlatform", e.target.value)}
              placeholder="Website, App"
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="Pricing">
            <Input
              value={form.tagsPricing}
              onChange={(e) => setField("tagsPricing", e.target.value)}
              placeholder="Free Trial, Paid"
              className="bg-background/40 border-border/40"
            />
          </Field>
          <Field label="Topic">
            <Input
              value={form.tagsTopic}
              onChange={(e) => setField("tagsTopic", e.target.value)}
              placeholder="AI Writing, AI Story Generator"
              className="bg-background/40 border-border/40"
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title="链接 Links JSON"
        description="数组项：{ kind, url, label? }；kind 见占位示例；保存时整体替换"
      >
        <Textarea
          value={form.links}
          onChange={(e) => setField("links", e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={LINKS_PLACEHOLDER}
          className="bg-background/40 border-border/40 font-mono text-xs"
        />
      </SectionCard>

      <SectionCard
        title="媒体 Media JSON"
        description="数组项：{ url, alt? }；仅允许图片 URL 或本地路径，禁止 HTML"
      >
        <Textarea
          value={form.media}
          onChange={(e) => setField("media", e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={MEDIA_PLACEHOLDER}
          className="bg-background/40 border-border/40 font-mono text-xs"
        />
      </SectionCard>

      <SectionCard
        title="FAQ"
        description="answer 允许留空；answer 为空的 FAQ 不会出现在公开页"
      >
        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="rounded-lg border border-border/40 bg-background/20 p-4 space-y-3"
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-3">
                  <Input
                    value={faq.question}
                    onChange={(e) =>
                      updateFaq(index, { question: e.target.value })
                    }
                    placeholder="问题"
                    className="bg-background/40 border-border/40"
                  />
                  <Textarea
                    value={faq.answer}
                    onChange={(e) =>
                      updateFaq(index, { answer: e.target.value })
                    }
                    placeholder="答案（可留空，留空则公开页不展示该条）"
                    rows={2}
                    className="bg-background/40 border-border/40"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setFaqs((prev) => prev.filter((_, i) => i !== index))
                  }
                  title="移除"
                >
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setFaqs((prev) => [...prev, { question: "", answer: "" }])
            }
            className="gap-2"
          >
            <Plus className="w-4 h-4" />
            添加 FAQ
          </Button>
        </div>
      </SectionCard>

      <div className="sticky bottom-4 flex justify-end gap-2 rounded-xl border border-border/40 bg-background/80 backdrop-blur-sm p-4">
        <Button variant="outline" asChild>
          <Link href="/admin/tools">取消</Link>
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "保存中..." : "保存全部修改"}
        </Button>
      </div>
    </motion.div>
  );
}
