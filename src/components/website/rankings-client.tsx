"use client";

import { Rankings } from "@/components/website/rankings";
import type { RankedWebsite } from "@/components/website/rankings";
import { toast } from "@/hooks/use-toast";

export function RankingsClient({ websites }: { websites: RankedWebsite[] }) {
  const handleVisit = async (website: RankedWebsite) => {
    try {
      fetch(`/api/websites/${website.id}/visit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      window.open(website.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error("Failed to record visit:", error);
      toast({
        variant: "destructive",
        title: "记录访问失败",
        description: "请稍后重试",
      });
    }
  };

  return <Rankings websites={websites} onVisit={handleVisit} />;
}
