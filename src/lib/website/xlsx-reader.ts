import { inflateRawSync } from "zlib";
import { readFileSync } from "fs";

/**
 * 最小化零依赖 xlsx (zip + xml) 读取器 — 仅覆盖本数据源需要的特性。
 * 返回每行为「小写表头 → 单元格文本」的记录数组。
 */

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  // 定位 End of Central Directory (PK\x05\x06)
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 xlsx/zip 文件");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let n = 0; n < entryCount; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");

    // 本地文件头: PK\x03\x04
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siMatches = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  for (const si of siMatches) {
    let text = "";
    const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    for (const t of tMatches) {
      text += unescapeXml(t.replace(/<t[^>]*>/, "").replace(/<\/t>$/, ""));
    }
    strings.push(text);
  }
  return strings;
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.replace(/\d+$/, "");
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function parseSheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowXml.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/r="([A-Z]+\d+)"/);
      if (!refMatch) continue;
      const col = columnIndex(refMatch[1]);
      const typeMatch = cellXml.match(/t="(\w+)"/);
      const type = typeMatch?.[1];
      let value = "";
      if (type === "inlineStr") {
        const t = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = t ? unescapeXml(t[1]) : "";
      } else {
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (v) {
          value = type === "s" ? shared[parseInt(v[1], 10)] ?? "" : unescapeXml(v[1]);
        }
      }
      cells[col] = value;
    }
    rows.push(cells);
  }
  return rows;
}

export function readXlsx(filePath: string): Record<string, string>[] {
  const entries = readZipEntries(readFileSync(filePath));
  const sheetEntry =
    entries.get("xl/worksheets/sheet1.xml") ??
    [...entries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort()
      .map((k) => entries.get(k))[0];
  if (!sheetEntry) throw new Error("xlsx 中找不到工作表");
  const shared = entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(entries.get("xl/sharedStrings.xml")!.toString("utf8"))
    : [];
  const rows = parseSheetRows(
    Buffer.isBuffer(sheetEntry) ? sheetEntry.toString("utf8") : "",
    shared
  );
  if (rows.length < 2) return [];
  // 表头小写归一化：容忍个别文件的大小写差异（如 Introduction vs introduction）
  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((name, i) => {
      if (name) record[name] = (row[i] ?? "").trim();
    });
    return record;
  });
}
