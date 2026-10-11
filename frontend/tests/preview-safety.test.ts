/**
 * 预览安全边界自动化测试（P1-5）。
 *
 * 中文注释：用 Node 内置 test runner（node --test）跑纯函数，不引入 vitest
 * 依赖；被测模块无 DOM/IO。覆盖 MIME 白名单的 XSS 边界与 zip 炸弹预检。
 * 运行：sh scripts/check.sh 或 npx node --test --experimental-strip-types tests/*.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { previewKind, canOpenInNewWindow, legacyOfficeHint, normalizeMime } from "../src/lib/preview/kind.ts";
import { maxBytesForKind } from "../src/lib/preview/limits.ts";
import { assertZipBudget, ZipBudgetError, ZipFormatError } from "../src/lib/preview/zip-budget.ts";

test("text/html 只能进入隔离预览框，改名也不能绕过", () => {
  // 中文注释：即使文件名叫 .txt，活文档仍不能走普通文本渲染
  assert.equal(previewKind("text/html", "notes.txt"), "html");
  assert.equal(previewKind("text/html", "page.html"), "html");
  assert.equal(previewKind("application/xhtml+xml", "x.txt"), "download");
  assert.equal(previewKind("TEXT/HTML; charset=utf-8", "a.txt"), "html");
});

test("脚本族与旧版 Office 不预览", () => {
  assert.equal(previewKind("text/javascript", "a.js"), "download");
  assert.equal(previewKind("application/javascript", "a.js"), "download");
  assert.equal(previewKind("application/msword", "a.docx"), "download");
  assert.equal(previewKind("image/tiff", "a.tif"), "download");
});

test("MIME 缺失才走扩展名兜底，具体 MIME 不看名字", () => {
  assert.equal(previewKind("application/octet-stream", "a.txt"), "text");
  assert.equal(previewKind("", "a.xlsx"), "sheet");
  assert.equal(previewKind(null, "a.docx"), "docx");
  assert.equal(previewKind("application/octet-stream", "a.unknown"), "download");
  assert.equal(previewKind("application/octet-stream", "page.html"), "html");
  // 中文注释：具体 MIME 优先于扩展名——PDF 内容叫 .txt 仍是 pdf
  assert.equal(previewKind("application/pdf", "a.txt"), "pdf");
  // 反向：纯文本内容叫 .xlsx 只当文本，不当表格解析
  assert.equal(previewKind("text/plain", "a.xlsx"), "text");
});

test("SVG 可 <img> 预览但禁止顶层打开", () => {
  assert.equal(previewKind("image/svg+xml", "a.svg"), "image");
  assert.equal(canOpenInNewWindow("image", "image/svg+xml"), false);
  assert.equal(canOpenInNewWindow("image", "image/png"), true);
  assert.equal(canOpenInNewWindow("pdf", "application/pdf"), true);
  assert.equal(canOpenInNewWindow("text", "text/plain"), false);
  assert.equal(canOpenInNewWindow("html", "text/html"), false);
});

test("normalizeMime 去参数并小写", () => {
  assert.equal(normalizeMime("Application/PDF; charset=binary"), "application/pdf");
  assert.equal(normalizeMime("  text/plain  "), "text/plain");
  assert.equal(normalizeMime(undefined), "");
});

test("旧版 Office 给出另存提示", () => {
  assert.match(legacyOfficeHint("application/msword", "a.doc") ?? "", /另存为/);
  assert.match(legacyOfficeHint("application/octet-stream", "report.PPT") ?? "", /另存为/);
  assert.equal(legacyOfficeHint("application/pdf", "a.pdf"), null);
});

test("kind 与 limits 的字节上限契约", () => {
  assert.equal(maxBytesForKind("image"), 0);
  assert.equal(maxBytesForKind("pdf"), 0);
  assert.equal(maxBytesForKind("download"), 0);
  assert.ok(maxBytesForKind("text") > 0);
  assert.equal(maxBytesForKind("html"), maxBytesForKind("text"));
  assert.ok(maxBytesForKind("sheet") > maxBytesForKind("text"));
  assert.ok(maxBytesForKind("docx") > 0);
});

// ---------- zip 炸弹预检 ----------

/** 构造只含中央目录的最小 zip 头，用于驱动 inspectZipBudget */
function fakeZip(entries: { uncompressed: number }[]): Uint8Array {
  const central = entries.map((entry) => {
    const item = new Uint8Array(46);
    const view = new DataView(item.buffer);
    view.setUint32(0, 0x02014b50, true); // 中央目录项签名
    view.setUint32(24, entry.uncompressed, true); // uncompressedSize
    return item;
  });
  const centralBytes = central.reduce((acc, item) => {
    const merged = new Uint8Array(acc.byteLength + item.byteLength);
    merged.set(acc, 0);
    merged.set(item, acc.byteLength);
    return merged;
  }, new Uint8Array(0));
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralBytes.byteLength, true);
  eocdView.setUint32(16, 0, true); // 中央目录从偏移 0 开始（本测试无 local header）
  const bytes = new Uint8Array(centralBytes.byteLength + eocd.byteLength);
  bytes.set(centralBytes, 0);
  bytes.set(eocd, centralBytes.byteLength);
  return bytes;
}

test("zip 解压体积超预算抛 ZipBudgetError", () => {
  const bomb = fakeZip([{ uncompressed: 200 * 1024 * 1024 }, { uncompressed: 200 * 1024 * 1024 }]);
  assert.throws(() => assertZipBudget(bomb, 80 * 1024 * 1024, "xlsx"), ZipBudgetError);
  const ok = fakeZip([{ uncompressed: 1024 }]);
  const report = assertZipBudget(ok, 80 * 1024 * 1024, "xlsx");
  assert.equal(report.entries, 1);
  assert.equal(report.totalUncompressedBytes, 1024);
});

test("非 zip / 结构损坏抛 ZipFormatError", () => {
  assert.throws(() => assertZipBudget(new Uint8Array(4), 1024, "docx"), ZipFormatError);
  assert.throws(() => assertZipBudget(new Uint8Array(100), 1024, "docx"), ZipFormatError);
});
