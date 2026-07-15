import { NextResponse } from "next/server";
import { ADMIN_COOKIE_NAME, adminCookieOptions } from "@/lib/auth/admin-auth";

export async function POST() {
  const response = NextResponse.json({ message: "已退出登录" }, { status: 200 });
  response.cookies.set(ADMIN_COOKIE_NAME, "", {
    ...adminCookieOptions,
    maxAge: 0,
  });
  return response;
}
