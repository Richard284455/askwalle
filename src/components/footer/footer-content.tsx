"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { motion } from "framer-motion";
import { Button } from "@/ui/common/button";
import { ArrowUpRight, Folder, Plus, Send, Trophy } from "lucide-react";
import { isAdminModeAtom, footerSettingsAtom } from "@/lib/atoms";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/ui/common/dialog";
import { Input } from "@/ui/common/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils/utils";
import type { FooterSettings } from "@/lib/types";

export default function FooterContent({
  initialSettings,
}: {
  initialSettings: FooterSettings;
}) {
  const [isAdmin] = useAtom(isAdminModeAtom);
  const [settings, setSettings] = useAtom(footerSettingsAtom);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newLink, setNewLink] = useState({ title: "", url: "" });
  const { toast } = useToast();

  // Initialize settings
  useEffect(() => {
    setSettings({
      copyright: initialSettings.copyright || "",
      icpBeian: initialSettings.icpBeian || "",
      links:
        initialSettings.links?.map((link) => ({
          title: link.title,
          url: link.url,
        })) || [],
      customHtml: initialSettings.customHtml || "",
    });
  }, [initialSettings, setSettings]);

  const handleAddLink = async () => {
    if (!newLink.title || !newLink.url) {
      toast({
        title: "错误",
        description: "请填写完整的链接信息",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await fetch("/api/footer-links", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(newLink),
      });

      if (!response.ok) throw new Error("Failed to add link");

      setSettings((prev) => ({
        ...prev,
        links: [...prev.links, { title: newLink.title, url: newLink.url }],
      }));

      setNewLink({ title: "", url: "" });
      setIsDialogOpen(false);

      toast({
        title: "添加成功",
        description: "新的页脚链接已添加",
      });
    } catch (error) {
      toast({
        title: "添加失败",
        description: "添加页脚链接时出错",
        variant: "destructive",
      });
    }
  };

  const handleRemoveLink = async (index: number) => {
    try {
      const response = await fetch(`/api/footer-links?id=${index}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to remove link");

      setSettings((prev) => ({
        ...prev,
        links: prev.links.filter((_, i) => i !== index),
      }));

      toast({
        title: "删除成功",
        description: "页脚链接已删除",
      });
    } catch (error) {
      toast({
        title: "删除失败",
        description: "删除页脚链接时出错",
        variant: "destructive",
      });
    }
  };

  return (
    <motion.footer
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "w-full border-t border-border",
        "bg-background/80 backdrop-blur-sm",
        "transition-colors duration-300"
      )}
    >
      <div className="container mx-auto px-4 py-8 md:py-10">
        <div className="grid gap-7 sm:grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr] lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
          <div>
            <Link href="/" className="inline-flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                AW
              </span>
              <span className="font-semibold">AskWalle AI Hub</span>
            </Link>
            <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
              A practical AI tools directory for discovering products across
              writing, image generation, coding, productivity, marketing, and
              business workflows.
            </p>
          </div>

          <FooterColumn title="Directory">
            <FooterLink href="/#all-tools">AI Tools</FooterLink>
            <FooterLink href="/categories" icon={<Folder className="h-3.5 w-3.5" />}>
              Categories
            </FooterLink>
            <FooterLink href="/rankings" icon={<Trophy className="h-3.5 w-3.5" />}>
              Rankings
            </FooterLink>
            <FooterLink href="/submit" icon={<Send className="h-3.5 w-3.5" />}>
              Submit Tool
            </FooterLink>
          </FooterColumn>

          <FooterColumn title="Resources">
            {settings.links.length > 0 ? (
              settings.links.map((link, index) => (
                <div key={`${link.url}-${index}`} className="flex min-w-0 items-center gap-1.5">
                  <a
                    href={link.url}
                    target={link.url.startsWith("/") ? undefined : "_blank"}
                    rel={link.url.startsWith("/") ? undefined : "noopener noreferrer"}
                    className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="truncate">{link.title}</span>
                    {!link.url.startsWith("/") && (
                      <ArrowUpRight className="h-3 w-3" />
                    )}
                  </a>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-5 w-5 rounded-full p-0",
                        "hover:bg-destructive/10 hover:text-destructive",
                        "transition-colors duration-200"
                      )}
                      onClick={() => handleRemoveLink(index)}
                    >
                      ×
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <div className="text-sm leading-6 text-muted-foreground">
                {isAdmin ? "Add footer links for privacy, terms, or contact." : "Privacy, terms, and contact links can be added by the site admin."}
              </div>
            )}
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="mt-1 h-8 gap-1.5"
                onClick={() => setIsDialogOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Add link
              </Button>
            )}
          </FooterColumn>

          <FooterColumn title="Site">
            <p className="text-sm leading-6 text-muted-foreground">
              Built for browsing, comparing, and submitting useful AI tools
              without inflated claims.
            </p>
          </FooterColumn>
        </div>

        <div className="mt-8 flex flex-col gap-3 border-t border-border/70 pt-5 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
          <div>{settings.copyright}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {settings.icpBeian && (
              <a
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground"
              >
                {settings.icpBeian}
              </a>
            )}
            <a
              href="https://github.com/liyown/ai-navigation"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-foreground"
            >
              Source project
            </a>
          </div>
        </div>

        {settings.customHtml && (
          <div
            className="mt-3 text-xs text-muted-foreground"
            dangerouslySetInnerHTML={{ __html: settings.customHtml }}
          />
        )}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="bg-background border-border">
          <DialogHeader>
            <DialogTitle>添加页脚链接</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              请填写链接的名称和地址
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                链接名称
              </label>
              <Input
                value={newLink.title}
                onChange={(e) =>
                  setNewLink((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="输入链接名称"
                className="border-input"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                链接地址
              </label>
              <Input
                value={newLink.url}
                onChange={(e) =>
                  setNewLink((prev) => ({ ...prev, url: e.target.value }))
                }
                placeholder="输入链接地址"
                className="border-input"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                className="border-input hover:bg-accent hover:text-accent-foreground"
              >
                取消
              </Button>
              <Button
                onClick={handleAddLink}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                添加
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  );
}

function FooterLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      {icon}
      {children}
    </Link>
  );
}
