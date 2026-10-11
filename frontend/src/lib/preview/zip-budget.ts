/**
 * zip 解压预算预检 —— 防 zip 炸弹。
 *
 * 中文注释：.xlsx / .docx 都是 zip。2 MB 的 zip 可解压到数 GB，而
 * read-excel-file 与 mammoth 会在主线程解压，**字节上限拦不住这个**。
 * 这里只读 zip 中央目录（EOCD → 中央目录项，累加 uncompressedSize），
 * **完全不解压**，约 60 行就能把内存上界封死。
 */

/** 解压总字节超预算 */
export class ZipBudgetError extends Error {
  readonly entries: number;
  readonly totalUncompressedBytes: number;
  readonly limit: number;

  constructor(label: string, entries: number, totalUncompressedBytes: number, limit: number) {
    super(
      `${label} 解压后体积超出预览上限（上限 ${limit} 字节，实际约 ${totalUncompressedBytes} 字节，${entries} 个条目）。`,
    );
    this.name = "ZipBudgetError";
    this.entries = entries;
    this.totalUncompressedBytes = totalUncompressedBytes;
    this.limit = limit;
  }
}

/** 非 zip / 结构损坏 / 无法判定大小 */
export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

export interface ZipBudgetReport {
  /** 中央目录里的条目数 */
  entries: number;
  /** 所有条目 uncompressedSize 之和 */
  totalUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
/** EOCD 最小长度（不含注释） */
const EOCD_MIN_LENGTH = 22;
/** 中央目录项固定部分长度 */
const CENTRAL_ENTRY_HEADER_LENGTH = 46;
/** 条目数上限：超过即视为结构异常，直接拒绝 */
const MAX_ENTRIES = 100_000;
/** ZIP64 用 0xFFFFFFFF 占位；无法在不解析 ZIP64 扩展的前提下确定真实大小 */
const ZIP64_PLACEHOLDER = 0xffffffff;

/**
 * 读取 zip 中央目录并累加解压后体积。不解压。
 */
export function inspectZipBudget(bytes: Uint8Array): ZipBudgetReport {
  if (bytes.byteLength < EOCD_MIN_LENGTH) {
    throw new ZipFormatError("文件不是有效的 zip（长度不足）");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;

  // ---- 定位 EOCD：在末尾 22..(22+65535) 字节内从后往前找签名 ----
  let eocdAt = -1;
  const scanFrom = Math.max(0, len - EOCD_MIN_LENGTH - 0xffff);
  for (let i = len - EOCD_MIN_LENGTH; i >= scanFrom; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocdAt = i;
      break;
    }
  }
  if (eocdAt < 0) {
    throw new ZipFormatError("文件不是有效的 zip（找不到中央目录结尾）");
  }

  const totalEntries = view.getUint16(eocdAt + 10, true);
  const centralSize = view.getUint32(eocdAt + 12, true);
  const centralOffset = view.getUint32(eocdAt + 16, true);

  if (totalEntries > MAX_ENTRIES) {
    throw new ZipFormatError(`zip 条目数异常（${totalEntries} 个）`);
  }
  if (centralOffset === ZIP64_PLACEHOLDER || centralSize === ZIP64_PLACEHOLDER) {
    // 中文注释：ZIP64 的真实偏移/大小在扩展字段里，这里不解析；预览场景直接拒绝是安全取舍
    throw new ZipFormatError("暂不支持预览 ZIP64 扩展的压缩包");
  }
  if (centralOffset >= len) {
    throw new ZipFormatError("文件不是有效的 zip（中央目录越界）");
  }

  // ---- 逐项累加 uncompressedSize（位于中央目录项偏移 24，4 字节小端） ----
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  for (let i = 0; i < totalEntries; i += 1) {
    if (offset + CENTRAL_ENTRY_HEADER_LENGTH > len) {
      throw new ZipFormatError("文件不是有效的 zip（中央目录项越界）");
    }
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new ZipFormatError("文件不是有效的 zip（中央目录项签名错误）");
    }
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);

    if (uncompressedSize === ZIP64_PLACEHOLDER) {
      throw new ZipFormatError("暂不支持预览 ZIP64 扩展的压缩包");
    }
    totalUncompressedBytes += uncompressedSize;

    offset += CENTRAL_ENTRY_HEADER_LENGTH + nameLen + extraLen + commentLen;
  }

  return { entries: totalEntries, totalUncompressedBytes };
}

/**
 * 断言解压后体积在预算内；超出抛 ZipBudgetError，结构异常抛 ZipFormatError。
 */
export function assertZipBudget(
  bytes: Uint8Array,
  maxTotalUncompressedBytes: number,
  label: string,
): ZipBudgetReport {
  const report = inspectZipBudget(bytes);
  if (report.totalUncompressedBytes > maxTotalUncompressedBytes) {
    throw new ZipBudgetError(
      label,
      report.entries,
      report.totalUncompressedBytes,
      maxTotalUncompressedBytes,
    );
  }
  return report;
}
