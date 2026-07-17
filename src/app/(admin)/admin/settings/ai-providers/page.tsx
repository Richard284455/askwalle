import { getProviderSettings } from "@/lib/website/ai-provider-config";
import { AIProviderSettings } from "@/components/admin/ai-provider-settings";

export const dynamic = "force-dynamic";

export default async function AIProvidersSettingsPage() {
  const providers = await getProviderSettings().catch(() => []);

  return (
    <div>
      <AIProviderSettings initialProviders={providers} />
    </div>
  );
}
