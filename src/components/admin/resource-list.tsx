"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Archive, Pencil, Plus, Upload } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Badge } from "@/ui/common/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/common/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/common/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { AdminResourceRecord } from "@/lib/resources/resource-admin";

const TYPE_LABELS: Record<string, string> = {
  news: "资讯",
  review: "评测",
  prompt: "提示词",
  skill: "技能",
  tutorial: "教程",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  published: "已发布",
  archived: "已归档",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "text-yellow-500",
  published: "text-green-500",
  archived: "text-muted-foreground",
};

export function ResourceList({
  initialResources,
}: {
  initialResources: AdminResourceRecord[];
}) {
  const { toast } = useToast();
  const [resources, setResources] = useState(initialResources);
  const [activeType, setActiveType] = useState<string>("all");
  const [activeStatus, setActiveStatus] = useState<string>("all");
  const [archiveTarget, setArchiveTarget] =
    useState<AdminResourceRecord | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const filtered = resources.filter((resource) => {
    const matchesType = activeType === "all" || resource.type === activeType;
    const matchesStatus =
      activeStatus === "all" || resource.status === activeStatus;
    return matchesType && matchesStatus;
  });

  const applyUpdated = (updated: AdminResourceRecord) => {
    setResources((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item))
    );
  };

  const handleStatusChange = async (
    resource: AdminResourceRecord,
    status: "draft" | "published"
  ) => {
    setPendingId(resource.id);
    try {
      const response = await fetch(`/api/resources/${resource.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success) {
        applyUpdated(data.data);
        toast({
          title: status === "published" ? "已发布" : "已转为草稿",
          description: resource.title,
        });
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
      setPendingId(null);
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    const target = archiveTarget;
    setArchiveTarget(null);
    setPendingId(target.id);
    try {
      const response = await fetch(`/api/resources/${target.id}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => null);
      if (response.ok && data?.success) {
        applyUpdated(data.data);
        toast({ title: "已归档", description: target.title });
      } else {
        toast({
          title: "归档失败",
          description: data?.message || "请重试",
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "归档失败", description: "请重试", variant: "destructive" });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 min-h-[calc(100vh-4rem)] space-y-6"
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-background/30 backdrop-blur-sm p-6 rounded-xl border border-border/40">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-foreground">
            资源管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            管理资讯、评测、提示词、技能与教程内容
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin" className="flex items-center gap-2">
              <ArrowLeft className="w-4 h-4" />
              返回后台
            </Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/admin/resources/new" className="flex items-center gap-2">
              <Plus className="w-4 h-4" />
              新建资源
            </Link>
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-border/40 bg-background/30 shadow-sm overflow-hidden backdrop-blur-sm">
        <div className="border-b border-border/40 bg-background/20 p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {["all", "news", "review", "prompt", "skill", "tutorial"].map(
              (type) => (
                <button
                  key={type}
                  onClick={() => setActiveType(type)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg border text-sm transition-all duration-200",
                    activeType === type
                      ? "bg-background/40 border-primary/30 text-foreground shadow-sm"
                      : "bg-background/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"
                  )}
                >
                  {type === "all" ? "全部类型" : TYPE_LABELS[type]}
                </button>
              )
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {["all", "draft", "published", "archived"].map((status) => (
              <button
                key={status}
                onClick={() => setActiveStatus(status)}
                className={cn(
                  "px-3 py-1.5 rounded-lg border text-sm transition-all duration-200",
                  activeStatus === status
                    ? "bg-background/40 border-primary/30 shadow-sm " +
                        (STATUS_COLORS[status] ?? "text-foreground")
                    : "bg-background/20 border-border/40 text-muted-foreground hover:text-foreground hover:border-border/60"
                )}
              >
                {status === "all" ? "全部状态" : STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-background/20 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-10"
                  >
                    暂无符合条件的资源
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((resource) => (
                  <TableRow key={resource.id}>
                    <TableCell className="max-w-[280px]">
                      <div className="font-medium truncate">{resource.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {resource.slug}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {TYPE_LABELS[resource.type] ?? resource.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{resource.category}</TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm font-medium",
                          STATUS_COLORS[resource.status]
                        )}
                      >
                        {STATUS_LABELS[resource.status] ?? resource.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {resource.publishedAt.slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/admin/resources/${resource.id}`}>
                            <Pencil className="w-4 h-4" />
                          </Link>
                        </Button>
                        {resource.status !== "published" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === resource.id}
                            onClick={() =>
                              handleStatusChange(resource, "published")
                            }
                            title="发布"
                          >
                            <Upload className="w-4 h-4 text-green-500" />
                          </Button>
                        )}
                        {resource.status === "published" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === resource.id}
                            onClick={() => handleStatusChange(resource, "draft")}
                            title="转为草稿"
                          >
                            <Upload className="w-4 h-4 rotate-180 text-yellow-500" />
                          </Button>
                        )}
                        {resource.status !== "archived" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pendingId === resource.id}
                            onClick={() => setArchiveTarget(resource)}
                            title="归档"
                          >
                            <Archive className="w-4 h-4 text-red-500" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认归档该资源？</AlertDialogTitle>
            <AlertDialogDescription>
              「{archiveTarget?.title}」将从公开页面下线，但数据仍会保留，可随时重新发布。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive}>归档</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
