import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { prisma } from "@/lib/prisma";

// GET /api/admin/tools/import/[batchId] — 批次详情 + 逐文件结果 + 该批工具计数
export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const unauthorized = await requireAdmin();
  if (unauthorized) return unauthorized;

  const batchId = parseInt((await params).batchId);
  if (Number.isNaN(batchId)) {
    return NextResponse.json(AjaxResponse.fail("无效的批次 ID"), {
      status: 400,
    });
  }

  const batch = await prisma.toolImportBatch.findUnique({
    where: { id: batchId },
    include: { files: { orderBy: { id: "asc" } } },
  });
  if (!batch) {
    return NextResponse.json(AjaxResponse.fail("批次不存在"), { status: 404 });
  }

  const toolCount = await prisma.website.count({
    where: { import_batch_id: batchId },
  });

  return NextResponse.json(
    AjaxResponse.ok({
      id: batch.id,
      name: batch.name,
      sourceDir: batch.source_dir,
      fileCount: batch.file_count,
      rowCount: batch.row_count,
      importedCount: batch.imported_count,
      skippedCount: batch.skipped_count,
      errorCount: batch.error_count,
      startedAt: batch.started_at.toISOString(),
      finishedAt: batch.finished_at?.toISOString() ?? null,
      toolCount,
      files: batch.files.map((f) => ({
        id: f.id,
        fileName: f.file_name,
        rowCount: f.row_count,
        importedCount: f.imported_count,
        skippedCount: f.skipped_count,
        errorCount: f.error_count,
        errorLog: f.error_log,
        level1: f.level1_category,
        level2: f.level2_category,
      })),
    })
  );
}
