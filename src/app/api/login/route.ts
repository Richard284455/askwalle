import { NextResponse } from "next/server";
import {
  ADMIN_COOKIE_NAME,
  adminCookieOptions,
  isAuthConfigured,
  isValidAdminPassword,
  signAdminToken,
} from "@/lib/auth/admin-auth";

export async function POST(request: Request) {
  try {
    const { password } = await request.json();

    if (!isAuthConfigured()) {
      return NextResponse.json(
        { message: "服务端认证未配置" },
        { status: 500 }
      );
    }

    if (!isValidAdminPassword(password)) {
      return NextResponse.json({ message: "密码错误" }, { status: 401 });
    }

    const token = signAdminToken();
    if (!token) {
      return NextResponse.json(
        { message: "服务端认证未配置" },
        { status: 500 }
      );
    }

    const response = NextResponse.json({ message: "登录成功" }, { status: 200 });
    response.cookies.set(ADMIN_COOKIE_NAME, token, adminCookieOptions);
    return response;
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ message: "登录失败，请重试" }, { status: 500 });
  }
}
