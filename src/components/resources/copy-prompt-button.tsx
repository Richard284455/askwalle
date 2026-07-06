"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/ui/common/button";

interface CopyPromptButtonProps {
  text: string;
}

export function CopyPromptButton({ text }: CopyPromptButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={handleCopy}
      className="gap-2 bg-white/70 dark:bg-background/60"
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy prompt"}
    </Button>
  );
}
