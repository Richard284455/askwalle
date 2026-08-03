import { redirect } from "next/navigation";

import { isAdminRequest } from "@/lib/auth/admin-auth";
import { NewsroomModelSettings } from "@/components/admin/newsroom-model-settings";
import { newsroomModelOptions, resolveNewsroomModel } from "@/lib/content/multilingual/model-settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = { title: "Newsroom 模型设置", robots: { index: false, follow: false } };

export default async function NewsroomModelPage() {
  // 布局的 redirect 与页面渲染是并行的，挡不住这里的取数 —— 自己先验一次
  if (!(await isAdminRequest())) redirect("/login");

  const current = await resolveNewsroomModel();
  const options = await newsroomModelOptions();
  return <NewsroomModelSettings initialCurrent={current} initialOptions={options} />;
}
