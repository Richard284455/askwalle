import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { exportDeadList } from "@/lib/website/tool-lifecycle";

// GET /api/admin/tools/lifecycle/export — dead 清单 CSV，供人工逐条核对
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const csv = await exportDeadList();
    return new NextResponse(`﻿${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dead-tools-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    console.error("Failed to export dead list:", error);
    return new NextResponse("export failed", { status: 500 });
  }
}
