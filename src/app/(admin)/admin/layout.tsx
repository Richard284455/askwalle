import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth/admin-auth";
import { AdminNav } from "@/components/admin/admin-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdminRequest())) {
    redirect("/login");
  }

  /*
   * 导航放在 layout 里，每个后台页面都带着它。
   *
   * 以前导航只长在 /admin 首页的组件里 —— 点进任何子页面之后就没有导航了，
   * 新加的页面因此根本没有入口可达，只能手敲地址。
   *
   * 注意：这里的 redirect 挡不住页面自身的取数（App Router 会并行渲染
   * layout 与 page），所以每个会读库的后台页面**还要各自验一次身份**。
   */
  return (
    <div className="min-h-screen">
      <AdminNav />
      {children}
    </div>
  );
}
