"use client";

import { useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/ui/common/button";

interface ToolVisitButtonProps {
  websiteId: number;
  url: string;
  label?: string;
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export function ToolVisitButton({
  websiteId,
  url,
  label = "Visit Website",
  size = "lg",
  className,
}: ToolVisitButtonProps) {
  const [isOpening, setIsOpening] = useState(false);

  async function handleVisit() {
    if (isOpening) return;

    setIsOpening(true);

    try {
      await fetch(`/api/websites/${websiteId}/visit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.warn("[ToolVisitButton] Visit tracking unavailable.");
    } finally {
      window.open(url, "_blank", "noopener,noreferrer");
      setIsOpening(false);
    }
  }

  return (
    <Button
      type="button"
      size={size}
      className={className}
      onClick={handleVisit}
      disabled={isOpening}
      aria-label={label}
    >
      {isOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {label}
      <ArrowUpRight className="h-4 w-4" />
    </Button>
  );
}
