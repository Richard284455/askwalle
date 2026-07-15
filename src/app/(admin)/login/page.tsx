import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth/admin-auth";
import { LoginForm } from "@/components/admin/login-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理员登录",
};

export default async function LoginPage() {
  if (await isAdminRequest()) {
    redirect("/admin");
  }

  return <LoginForm />;
}
