import jwt from "jsonwebtoken";
import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";

export const ADMIN_COOKIE_NAME = "admin_token";

// 24 小时有效期；过期后需重新登录
const TOKEN_TTL_SECONDS = 60 * 60 * 24;

export const adminCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: TOKEN_TTL_SECONDS,
};

function getJwtSecret(): string | null {
  return process.env.JWT_SECRET || null;
}

export function isAuthConfigured(): boolean {
  return Boolean(process.env.JWT_SECRET && process.env.ADMIN_PASSWORD);
}

// 常数时间比较，避免时序侧信道；先哈希以对齐长度
export function isValidAdminPassword(password: unknown): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof password !== "string") return false;
  const a = createHash("sha256").update(password).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function signAdminToken(): string | null {
  const secret = getJwtSecret();
  if (!secret) return null;
  return jwt.sign({ role: "admin" }, secret, {
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

export function verifyAdminToken(token: string | undefined): boolean {
  const secret = getJwtSecret();
  if (!secret || !token) return false;
  try {
    const payload = jwt.verify(token, secret);
    return (
      typeof payload === "object" &&
      payload !== null &&
      (payload as jwt.JwtPayload).role === "admin"
    );
  } catch {
    return false;
  }
}

// 服务端组件 / 路由处理器中读取当前请求的管理员身份
export async function isAdminRequest(): Promise<boolean> {
  const cookieStore = await cookies();
  return verifyAdminToken(cookieStore.get(ADMIN_COOKIE_NAME)?.value);
}

// 路由处理器守卫：未认证时返回 401 响应，已认证返回 null
export async function requireAdmin(): Promise<NextResponse | null> {
  if (await isAdminRequest()) return null;
  return NextResponse.json(AjaxResponse.fail("Unauthorized"), { status: 401 });
}
