"use client";

import { usePathname } from "next/navigation";

/**
 * 前台的页头与页脚。
 *
 * 后台与登录页不该套前台外壳：后台有自己的常驻导航，两层导航叠在一起
 * 既占掉大半屏，又让人分不清「现在点的是前台还是后台」。
 *
 * 用客户端组件按路径判断，而不是把 Header/Footer 挪进 (app) 路由组 ——
 * 首页在路由组之外，挪过去要动首页的位置，代价比这里大得多。
 * header / footer 以 props 传入，因此它们仍然是服务端组件，不会被拖进客户端包。
 */
const CHROME_FREE_PREFIXES = ["/admin", "/login"];

export function SiteChrome({
  header, footer, children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const bare = CHROME_FREE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (bare) return <main className="flex-1">{children}</main>;

  return (
    <>
      {header}
      <main className="flex-1">{children}</main>
      {footer}
    </>
  );
}
