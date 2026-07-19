import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";

// GET /api/admin/tools/import/batches — 导入批次列表
export async function GET() {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  try {
    const batches = await prisma.toolImportBatch.findMany({
      orderBy: { id: "desc" },
      take: 100,
    });
    return NextResponse.json(
      AjaxResponse.ok(
        batches.map((b) => ({
          id: b.id,
          name: b.name,
          sourceDir: b.source_dir,
          fileCount: b.file_count,
          rowCount: b.row_count,
          importedCount: b.imported_count,
          skippedCount: b.skipped_count,
          errorCount: b.error_count,
          startedAt: b.started_at.toISOString(),
          finishedAt: b.finished_at?.toISOString() ?? null,
        }))
      )
    );
  } catch (error) {
    console.error("Failed to list import batches:", error);
    return NextResponse.json(AjaxResponse.fail("获取导入批次失败"), {
      status: 500,
    });
  }
}
