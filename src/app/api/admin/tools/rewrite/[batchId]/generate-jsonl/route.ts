import { NextResponse } from "next/server";
import { AjaxResponse } from "@/lib/utils";
import { requireAdmin } from "@/lib/auth/admin-auth";
import { buildOpenAIBatchJsonl } from "@/lib/website/tool-rewrite-batch";

// POST /api/admin/tools/rewrite/[batchId]/generate-jsonl
// 生成 JSONL 并返回行数 + 前 2 行预览（不含任何密钥）
export async function POST(
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

  try {
    const result = await buildOpenAIBatchJsonl(batchId);
    if (!result.ok) {
      return NextResponse.json(AjaxResponse.fail(result.message), {
        status: 400,
      });
    }
    const previewLines = result.jsonl.split("\n").slice(0, 2);
    return NextResponse.json(
      AjaxResponse.ok({
        lineCount: result.lineCount,
        preview: previewLines,
      })
    );
  } catch (error) {
    console.error("Failed to generate JSONL:", error);
    return NextResponse.json(AjaxResponse.fail("生成 JSONL 失败"), {
      status: 500,
    });
  }
}
