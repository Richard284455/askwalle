import { NewsroomModelSettings } from "@/components/admin/newsroom-model-settings";
import { newsroomModelOptions, resolveNewsroomModel } from "@/lib/content/multilingual/model-settings";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata = { title: "Newsroom 模型设置", robots: { index: false, follow: false } };

export default async function NewsroomModelPage() {
  const [current, options] = await Promise.all([resolveNewsroomModel(), newsroomModelOptions()]);
  return <NewsroomModelSettings initialCurrent={current} initialOptions={options} />;
}
