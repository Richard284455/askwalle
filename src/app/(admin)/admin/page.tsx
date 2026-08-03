import { redirect } from 'next/navigation';

import { isAdminRequest } from '@/lib/auth/admin-auth';
import { getWebsites, getCategories } from './actions';
import { AdminPageClient } from '@/components/admin/admin-page-client';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  /*
   * 自己先验一次身份，**不能只靠布局里的 redirect**。
   *
   * App Router 会并行渲染 layout 与 page，布局那句 redirect 拦不住这里的取数：
   * 未登录的请求照样会把下面两条全表查询跑完。后台首页恰好是最重的一页，
   * 于是任何一次扫描、预取、误点都在白跑两次全表，
   * 把只有 5 条的连接池占着不放。
   */
  if (!(await isAdminRequest())) redirect('/login');

  // 顺序取，不用 Promise.all —— 两条查询共用同一个池，并行只是把它占得更满
  const websites = await getWebsites();
  const categories = await getCategories();

  return (
    <div>
      <AdminPageClient initialWebsites={websites} initialCategories={categories} />
    </div>
  );
}