import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";

/**
 * 后台上传 Excel 的临时存储。文件写入项目根下 gitignored 的 .import-uploads/<token>/。
 * token 是 UUID；所有路径都锚定在 UPLOAD_ROOT 内，拒绝路径穿越。
 * confirm 完成后由调用方 clearUpload 清理。
 */

export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const UPLOAD_ROOT = path.join(process.cwd(), ".import-uploads");
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type UploadValidationError = { fileName: string; reason: string };

export type SavedUpload = {
  token: string;
  files: { filePath: string; fileName: string }[];
};

function ensureRoot() {
  if (!existsSync(UPLOAD_ROOT)) mkdirSync(UPLOAD_ROOT, { recursive: true });
}

// token → 安全目录（严格校验，杜绝穿越）
function tokenDir(token: string): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const dir = path.join(UPLOAD_ROOT, token);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) return null;
  return dir;
}

// 清理文件名，仅保留 basename，防止路径穿越
function safeFileName(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^\w.\-（）()一-龥 ]/g, "_") || "upload.xlsx";
}

export type IncomingFile = { name: string; size: number; bytes: Buffer };

export function validateUploads(
  files: IncomingFile[]
): { ok: true } | { ok: false; errors: UploadValidationError[] } {
  const errors: UploadValidationError[] = [];
  if (files.length === 0) errors.push({ fileName: "-", reason: "未选择任何文件" });
  if (files.length > MAX_FILES) {
    errors.push({ fileName: "-", reason: `单次最多 ${MAX_FILES} 个文件` });
  }
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xlsx")) {
      errors.push({ fileName: file.name, reason: "只允许 .xlsx 文件" });
    } else if (file.size > MAX_FILE_BYTES) {
      errors.push({ fileName: file.name, reason: "单文件超过 20MB" });
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// 清理超过 TTL（默认 1 小时）的 preview 遗留目录，避免临时文件累积
const UPLOAD_TTL_MS = 60 * 60 * 1000;

export function sweepStaleUploads(maxAgeMs = UPLOAD_TTL_MS): void {
  if (!existsSync(UPLOAD_ROOT)) return;
  const now = Date.now();
  for (const entry of readdirSync(UPLOAD_ROOT)) {
    // 同时清理 preview 遗留（<token>）与 confirm 崩溃遗留（<token>.claimed）
    const base = entry.endsWith(".claimed") ? entry.slice(0, -".claimed".length) : entry;
    if (!TOKEN_PATTERN.test(base)) continue;
    const dir = path.join(UPLOAD_ROOT, entry);
    try {
      if (now - statSync(dir).mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // 忽略单个目录清理失败
    }
  }
}

export function saveUploads(files: IncomingFile[]): SavedUpload {
  ensureRoot();
  sweepStaleUploads();
  const token = randomUUID();
  const dir = tokenDir(token)!;
  mkdirSync(dir, { recursive: true });
  const saved: { filePath: string; fileName: string }[] = [];
  files.forEach((file, index) => {
    const fileName = safeFileName(file.name);
    // 前缀序号避免同名覆盖
    const stored = `${String(index).padStart(2, "0")}-${fileName}`;
    const filePath = path.join(dir, stored);
    writeFileSync(filePath, file.bytes);
    saved.push({ filePath, fileName });
  });
  return { token, files: saved };
}

export function listUpload(token: string): SavedUpload | null {
  const dir = tokenDir(token);
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .sort()
    .map((stored) => ({
      filePath: path.join(dir, stored),
      // 去掉 "NN-" 前缀还原原始文件名
      fileName: stored.replace(/^\d{2}-/, ""),
    }));
  return files.length ? { token, files } : null;
}

export function clearUpload(token: string): void {
  const dir = tokenDir(token);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * 原子性占用 token：把 <token> 目录重命名为 <token>.claimed。
 * renameSync 是原子操作——重复/并发 confirm 只有第一个成功，其余拿到 null，
 * 从而避免同一 previewToken 被重复导入。返回占用后的文件列表（路径指向 .claimed 目录）。
 */
export function claimUpload(token: string): SavedUpload | null {
  const dir = tokenDir(token);
  if (!dir || !existsSync(dir)) return null;
  const claimedDir = `${dir}.claimed`;
  try {
    renameSync(dir, claimedDir);
  } catch {
    // 已被其它请求占用或已过期
    return null;
  }
  const files = readdirSync(claimedDir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx"))
    .sort()
    .map((stored) => ({
      filePath: path.join(claimedDir, stored),
      fileName: stored.replace(/^\d{2}-/, ""),
    }));
  if (!files.length) {
    rmSync(claimedDir, { recursive: true, force: true });
    return null;
  }
  return { token, files };
}

// 清理 claim 后的目录（confirm 结束后调用，成功失败都清）
export function clearClaimedUpload(token: string): void {
  const dir = tokenDir(token);
  if (!dir) return;
  const claimedDir = `${dir}.claimed`;
  if (existsSync(claimedDir)) rmSync(claimedDir, { recursive: true, force: true });
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
