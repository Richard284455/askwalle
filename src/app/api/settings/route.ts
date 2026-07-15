import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/db";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";

export interface SettingItem {
  key: string;
  value: string;
}

// 不允许通过公开接口读取的敏感设置项
const SENSITIVE_SETTING_KEYS = new Set(["adminPassword"]);

// Get custom settings
export async function GET() {
  try {
    const settings = await prisma.setting.findMany({
      select: {
        key: true,
        value: true,
      },
    });

    // Convert array to object with key-value pairs
    const settingsObject = settings.reduce(
      (acc: Record<string, string>, setting) => {
        if (!SENSITIVE_SETTING_KEYS.has(setting.key)) {
          acc[setting.key] = setting.value;
        }
        return acc;
      },
      {}
    );

    return NextResponse.json(AjaxResponse.ok(settingsObject));
  } catch (error) {
    return NextResponse.json(AjaxResponse.fail("Failed to fetch settings"));
  }
}

// 更新设置
export async function PUT(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json();

    // Check if body is null or not an object
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        AjaxResponse.fail("Request body must be an object")
      );
    }

    // Convert body entries to updateMany format and create update promises
    const updatePromises = Object.entries(body).map(async ([key, value]) => {
      return prisma.setting.update({
        where: { key },
        data: { value: String(value) },
      });
    });

    // Execute all updates in parallel
    const results = await Promise.all(updatePromises);

    return NextResponse.json(
      AjaxResponse.ok({
        updated: results.length,
        total: Object.keys(body).length,
      })
    );
  } catch (error) {
    console.error("Failed to update settings:", error);
    return NextResponse.json(AjaxResponse.fail("Failed to update settings"));
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!body || (!body.key && !body.keys)) {
      return NextResponse.json(
        AjaxResponse.fail("Missing required parameter: key or keys"),
        { status: 400 }
      );
    }

    let settings;

    if (body.keys) {
      // Handle multiple keys
      const requestedKeys = (body.keys as string[]).filter(
        (key) => !SENSITIVE_SETTING_KEYS.has(key)
      );
      const settingsArray = await prisma.setting.findMany({
        where: {
          key: {
            in: requestedKeys,
          },
        },
      });

      // Convert array to object with key-value pairs
      settings = settingsArray.reduce(
        (acc: Record<string, string>, setting) => {
          acc[setting.key] = setting.value;
          return acc;
        },
        {}
      );
    } else {
      // Handle single key
      if (SENSITIVE_SETTING_KEYS.has(body.key)) {
        return NextResponse.json(AjaxResponse.ok({}));
      }
      const setting = await prisma.setting.findUnique({
        where: { key: body.key },
      });
      settings = setting ? { [setting.key]: setting.value } : {};
    }

    return NextResponse.json(AjaxResponse.ok(settings));
  } catch (error) {
    return NextResponse.json(AjaxResponse.fail("Failed to get settings"), {
      status: 500,
    });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");

    if (!key) {
      return NextResponse.json(
        AjaxResponse.fail("Missing required parameter: key"),
        { status: 400 }
      );
    }

    await prisma.setting.delete({
      where: { key },
    });

    return NextResponse.json(AjaxResponse.ok(null));
  } catch (error) {
    console.error("Failed to delete setting:", error);
    return NextResponse.json(AjaxResponse.fail("Failed to delete setting"), {
      status: 500,
    });
  }
}
