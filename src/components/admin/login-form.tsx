"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import { Button } from "@/ui/common/button";
import { Input } from "@/ui/common/input";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || loading) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        router.push("/admin");
        router.refresh();
        return;
      }

      const data = await response.json().catch(() => null);
      setError(data?.message || "登录失败，请重试");
    } catch {
      setError("登录失败，请重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="container max-w-md mx-auto px-4 py-16 min-h-[calc(100vh-4rem)] flex items-center"
    >
      <div className="w-full rounded-xl border border-border/40 bg-background/30 backdrop-blur-sm p-8 space-y-6">
        <div className="space-y-2 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Lock className="h-5 w-5" />
          </span>
          <h1 className="text-2xl font-semibold text-foreground">管理员登录</h1>
          <p className="text-sm text-muted-foreground">
            输入管理员密码以访问后台管理
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="管理员密码"
            autoFocus
            autoComplete="current-password"
            className="bg-background/40 border-border/40"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !password}>
            {loading ? "登录中..." : "登录"}
          </Button>
        </form>
      </div>
    </motion.div>
  );
}
