import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth/admin-auth";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdminRequest())) {
    redirect("/login");
  }

  return <>{children}</>;
}
