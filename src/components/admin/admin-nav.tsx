"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BookOpen, Flame, ListFilter, ListTodo, LogOut, Newspaper, Settings, Sparkles, Wrench,
} from "lucide-react";

/**
 * 后台的常驻导航。
 *
 * 放在 layout 里而不是某一个页面里 —— 以前导航只长在 `/admin` 首页上，
 * 点进任何子页面之后就再也看不到它了：新加的页面根本没有入口可达，
 * 只能靠手敲地址。
 *
 * 两层：主区段一行，当前区段的子页面另起一行。
 * 子页面平铺进主行的话，一屏放不下，而且看不出从属关系。
 */

type NavItem = {
  /** 点击后去哪儿。区段本身没有页面时，指向它的第一个子页面 */
  href: string;
  /**
   * 高亮判定用的路径前缀。默认取 href ——
   * 但「内容审核」这种区段自己没有页面，href 指向子页，
   * 前缀却要用 /admin/content，否则进了 Newsroom 队列就不高亮了。
   */
  match?: string;
  label: string;
  icon: typeof Wrench;
  children?: NavItem[];
};

const NAV: NavItem[] = [
  { href: "/admin", label: "网站管理", icon: ListFilter },
  {
    href: "/admin/tools", label: "工具管理", icon: Wrench,
    children: [
      { href: "/admin/tools", label: "工具列表", icon: Wrench },
      { href: "/admin/tools/review", label: "工具审核", icon: Newspaper },
      { href: "/admin/tools/import", label: "批量导入", icon: BookOpen },
      { href: "/admin/tools/rewrite", label: "批量改写", icon: Sparkles },
      { href: "/admin/tools/lifecycle", label: "生命周期", icon: ListTodo },
    ],
  },
  { href: "/admin/resources", label: "资源管理", icon: BookOpen },
  {
    // /admin/content 本身没有页面，直接链过去会 404
    href: "/admin/content/articles", match: "/admin/content", label: "内容审核", icon: Newspaper,
    children: [
      { href: "/admin/content/articles", label: "资讯草稿", icon: Newspaper },
      { href: "/admin/content/aihot", label: "Newsroom 队列", icon: Flame },
    ],
  },
  { href: "/admin/jobs", label: "任务", icon: ListTodo },
  {
    href: "/admin/settings", label: "系统设置", icon: Settings,
    children: [
      { href: "/admin/settings", label: "站点设置", icon: Settings },
      { href: "/admin/settings/ai-providers", label: "AI 服务商", icon: Sparkles },
      { href: "/admin/settings/newsroom-model", label: "Newsroom 模型", icon: Flame },
    ],
  },
];

/**
 * 当前所在的主区段。
 *
 * 用前缀匹配而不是全等：子页面（/admin/tools/review、/admin/content/aihot）
 * 也该把所属区段点亮，否则一点进去导航就「失去焦点」，
 * 看不出自己在哪儿。`/admin` 是所有路径的前缀，所以单独全等处理。
 */
function activeSection(pathname: string): NavItem | undefined {
  const prefixOf = (s: NavItem) => s.match ?? s.href;
  const matches = NAV.filter((s) => prefixOf(s) !== "/admin" && pathname.startsWith(prefixOf(s)));
  // 取最长匹配：/admin/settings 与 /admin/settings/ai-providers 都命中时要选后者所属的区段
  return matches.sort((a, b) => prefixOf(b).length - prefixOf(a).length)[0]
    ?? (pathname === "/admin" ? NAV[0] : undefined);
}

export function AdminNav() {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const section = activeSection(pathname);

  async function logout() {
    await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/95 backdrop-blur">
      <div className="mx-auto w-full max-w-[1400px] px-4">
        <div className="flex flex-wrap items-center gap-2 py-2.5">
          <Link href="/admin" className="mr-2 shrink-0 text-sm font-semibold">
            AskWalle 后台
          </Link>

          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => {
              const { href, label, icon: Icon } = item;
              const active = section === item;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                  }`}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border/70 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              查看前台 ↗
            </Link>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              退出登录
            </button>
          </div>
        </div>

        {section?.children?.length ? (
          <div className="flex flex-wrap items-center gap-1 border-t border-border/50 py-2">
            {section.children.map(({ href, label, icon: Icon }) => {
              // 子页面用全等：/admin/settings 是其它子页面的前缀，前缀匹配会同时点亮多个
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </Link>
              );
            })}
          </div>
        ) : null}
      </div>
    </header>
  );
}
