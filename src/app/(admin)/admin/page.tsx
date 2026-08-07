import { redirect } from 'next/navigation';

import { isAdminRequest } from '@/lib/auth/admin-auth';
import { getWebsites, getCategories, getStatusCounts } from './actions';
import { AdminPageClient } from '@/components/admin/admin-page-client';

export const dynamic = 'force-dynamic';

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const STATUSES = ['pending', 'approved', 'rejected'];

export default async function AdminPage({ searchParams }: Props) {
  /*
   * 自己先验一次身份，**不能只靠布局里的 redirect**。
   *
   * App Router 会并行渲染 layout 与 page，布局那句 redirect 拦不住这里的取数：
   * 未登录的请求照样会把下面的查询跑完。后台首页恰好是最重的一页，
   * 于是任何一次扫描、预取、误点都在白跑查询，把连接池占着不放。
   */
  if (!(await isAdminRequest())) redirect('/login');

  /*
   * 筛选条件放在 URL 上，不放在组件 state 里。
   *
   * 分页要下推到 SQL，那么「当前是哪一页、筛的哪个状态」就必须是服务端
   * 也看得见的东西。放在 URL 上还顺带解决了刷新丢筛选、
   * 以及审完一条回来又要重新筛一遍的问题。
   */
  const sp = await searchParams;
  const rawStatus = one(sp.status);
  const status = rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'pending';
  const rawCategory = one(sp.category);
  const categoryId = rawCategory && rawCategory !== 'all' ? Number(rawCategory) : null;
  const q = one(sp.q)?.trim() || undefined;
  const page = Math.max(1, Number(one(sp.page) ?? '1') || 1);

  const filter = {
    categoryId: Number.isFinite(categoryId as number) ? categoryId : null,
    q,
  };

  // 顺序取：三条查询共用同一个只有 5 条的池，并行只会把它占得更满
  const list = await getWebsites({ ...filter, status, page });
  const counts = await getStatusCounts(filter);
  const categories = await getCategories();

  return (
    <div>
      <AdminPageClient
        websites={list.rows}
        categories={categories}
        counts={counts}
        activeStatus={status}
        activeCategory={rawCategory ?? 'all'}
        query={q ?? ''}
        page={list.page}
        pageSize={list.pageSize}
        totalPages={list.totalPages}
        total={list.total}
      />
    </div>
  );
}
