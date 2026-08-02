import Link from "next/link";

import { getProviderSettings } from "@/lib/website/ai-provider-config";
import { AIProviderSettings } from "@/components/admin/ai-provider-settings";

export const dynamic = "force-dynamic";

export default async function AIProvidersSettingsPage() {
  const providers = await getProviderSettings().catch(() => []);

  return (
    <div>
      <div className="mx-auto w-full max-w-5xl px-4 pt-6">
        <p className="rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-sm">
          Newsroom（Trending / AI Updates / Daily Briefing）改写与翻译用哪个模型，在{" "}
          <Link href="/admin/settings/newsroom-model" className="font-medium underline">Newsroom 模型设置</Link>{" "}
          里单独选择。
        </p>
      </div>
      <AIProviderSettings initialProviders={providers} />
    </div>
  );
}
