/**
 * 纯逻辑层：PDF 阅读位置记录的解析/合并，以及视图状态的好坏判定。
 *
 * 刻意不 import obsidian —— 这一层可以打成 CJS 在 Node 里直接跑回归测试。
 */

export type ViewKind = "pdf" | "canvas" | "excalidraw";

/**
 * pdf.js 存在 `localStorage["pdfjs.history"]` 里的一条记录。
 * 字段全部原样搬运，不自己造 —— 因为要写回去给 pdf.js 自己读。
 */
export interface PdfEntry {
  fingerprint: string;
  page?: number | null;
  zoom?: number | string;
  scrollLeft?: number;
  scrollTop?: number;
  rotation?: number;
  sidebarView?: number;
  scrollMode?: number;
  spreadMode?: number;
  sidebarWidth?: number;
  [k: string]: unknown;
}

/** 我们自己的记录，按**文件路径**存 —— 这点很关键，pdf.js 是按内容指纹存的 */
export interface ViewRecord {
  kind: ViewKind;
  at: number;
  /** pdf：pdf.js 那条记录的原样副本（含 fingerprint） */
  pdf?: PdfEntry;
  /** canvas / excalidraw：视窗位置（场景坐标）与缩放 */
  x?: number;
  y?: number;
  zoom?: number;
  /** 画布可视尺寸，仅作诊断 */
  w?: number;
  h?: number;
}

export type Records = Record<string, ViewRecord>;

/**
 * pdf.js 的 ViewHistory 上限是 20，一旦到 20 它就会 `files.shift()` 丢掉最旧的。
 * 我们跟着只留 19 条，避免自己写进去的表反而被它挤掉一条。
 */
export const PDF_HISTORY_CAP = 19;
export const PDF_HISTORY_KEY = "pdfjs.history";
export const MAX_RECORDS = 400;

/** pdf.js 认得的字段，比对"变没变"只看这些 */
const PDF_FIELDS = [
  "page",
  "zoom",
  "scrollLeft",
  "scrollTop",
  "rotation",
  "sidebarView",
  "scrollMode",
  "spreadMode",
  "sidebarWidth",
] as const;

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ── PDF 记录 ────────────────────────────────────────────────

export function normalizePdfEntry(raw: unknown): PdfEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const fingerprint = text(src.fingerprint);
  if (!fingerprint) return null;
  const out: PdfEntry = { ...src, fingerprint };
  const page = num(src.page);
  // page 可能是 null（pdf.js 新建条目时就长这样），保持原样即可
  out.page = page !== null && page >= 1 ? Math.floor(page) : null;
  for (const k of ["scrollLeft", "scrollTop", "rotation", "sidebarView"] as const) {
    const v = num(src[k]);
    if (v !== null) out[k] = v;
  }
  const zoom = num(src.zoom) ?? text(src.zoom);
  if (zoom !== undefined && zoom !== null) out.zoom = zoom;
  return out;
}

/** 这条记录够不够格当"上次读到哪"用 —— 没有页码的都是半成品 */
export function isPdfEntryUsable(e: PdfEntry | null | undefined): boolean {
  if (!e || !e.fingerprint) return false;
  const p = num(e.page);
  return p !== null && p >= 1;
}

export function samePdfValues(a: PdfEntry | null, b: PdfEntry | null): boolean {
  if (!a || !b) return false;
  for (const k of PDF_FIELDS) {
    const av = a[k] === undefined ? null : a[k];
    const bv = b[k] === undefined ? null : b[k];
    if (!Object.is(av, bv)) return false;
  }
  return true;
}

/** JSON.parse，但只在结果确实是对象时才认 */
function parseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parsePdfHistory(raw: string | null | undefined): { files: PdfEntry[] } {
  if (typeof raw !== "string" || !raw) return { files: [] };
  const parsed = parseJsonObject(raw);
  const listed = parsed ? parsed.files : undefined;
  const rawFiles: unknown[] = Array.isArray(listed) ? listed : [];
  const files: PdfEntry[] = [];
  for (const f of rawFiles) {
    const e = normalizePdfEntry(f);
    if (e) files.push(e);
  }
  return { files };
}

export function serializePdfHistory(files: PdfEntry[]): string {
  return JSON.stringify({ files });
}

/** 把我们的记录里所有可用的 PDF 条目取出来（不可用的丢掉，绝不用它覆盖有效数据） */
export function pdfEntriesFromRecords(records: Records): PdfEntry[] {
  const out: PdfEntry[] = [];
  for (const rec of Object.values(records)) {
    if (!rec || rec.kind !== "pdf" || !rec.pdf) continue;
    if (!isPdfEntryUsable(rec.pdf)) continue;
    out.push({ ...rec.pdf });
  }
  return out;
}

/**
 * 合成 pdf.js 那张表。
 *
 * 优先级：**磁盘上的 < 我们记的 < 当前打开着的**。
 *  - 磁盘上那条可能已经过期（多开时被别人的旧快照整份覆盖过）；
 *  - 我们按路径记的那份是上次看到的实况；
 *  - 打开着的视图里那条永远最新，挨个滚动都在写它。
 *
 * 后进来的覆盖先进来的（按字段合并），顺序就是优先级。
 */
export function mergePdfHistory(
  disk: PdfEntry[],
  records: PdfEntry[],
  live: PdfEntry[],
  cap = PDF_HISTORY_CAP,
): { files: PdfEntry[]; changed: boolean } {
  const order: string[] = [];
  const byFp = new Map<string, PdfEntry>();
  const put = (e: PdfEntry | null | undefined) => {
    if (!e || !e.fingerprint) return;
    const cur = byFp.get(e.fingerprint);
    if (!cur) {
      byFp.set(e.fingerprint, { ...e });
      order.push(e.fingerprint);
      return;
    }
    const next: PdfEntry = { ...cur };
    for (const k of Object.keys(e)) {
      const v = e[k];
      if (v === undefined) continue; // 别用 undefined 盖掉已有的值
      next[k] = v;
    }
    byFp.set(e.fingerprint, next);
  };

  for (const e of disk) put(e);
  for (const e of records) put(e);
  for (const e of live) put(e);

  let files = order.map((fp) => byFp.get(fp));
  if (files.length > cap) files = files.slice(files.length - cap);

  const onDisk = new Map(disk.map((e) => [e.fingerprint, e]));
  let changed = files.length !== disk.length;
  if (!changed) {
    for (const f of files) {
      const d = onDisk.get(f.fingerprint);
      if (!d || !samePdfValues(d, f)) {
        changed = true;
        break;
      }
    }
  }
  return { files, changed };
}

/**
 * Obsidian 深链接那条路的还原地址：`#page=N`。
 * 只带页码 —— 拖动位置由"写回 pdf.js 自己的存储"那条主路负责，这里不冒险造 zoom/offset 参数。
 */
export function pageHashForEntry(e: PdfEntry): string | null {
  const p = num(e.page);
  if (p === null || p < 1) return null;
  return `#page=${Math.floor(p)}`;
}

// ── 画布视窗 ────────────────────────────────────────────────

function almost(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/** 两个视窗算不算"同一个" —— 位置给 1.5 场景单位容差，缩放给 1% 相对容差 */
export function closeViewport(
  a: Partial<ViewRecord> | null | undefined,
  b: Partial<ViewRecord> | null | undefined,
  posTol = 1.5,
  zoomRel = 0.01,
): boolean {
  if (!a || !b) return false;
  const ax = num(a.x);
  const ay = num(a.y);
  const az = num(a.zoom);
  const bx = num(b.x);
  const by = num(b.y);
  const bz = num(b.zoom);
  if (ax === null || ay === null || az === null || az <= 0) return false;
  if (bx === null || by === null || bz === null || bz <= 0) return false;
  if (!almost(ax, bx, posTol) || !almost(ay, by, posTol)) return false;
  return almost(az, bz, Math.max(0.005, bz * zoomRel));
}

// ── 记录整体 ────────────────────────────────────────────────

export function normalizeRecord(raw: unknown): ViewRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const kind = src.kind;
  if (kind !== "pdf" && kind !== "canvas" && kind !== "excalidraw") return null;
  const at = num(src.at) ?? 0;
  if (kind === "pdf") {
    const pdf = normalizePdfEntry(src.pdf);
    if (!pdf) return null;
    return { kind, at, pdf };
  }
  const x = num(src.x);
  const y = num(src.y);
  const zoom = num(src.zoom);
  if (x === null || y === null || zoom === null || zoom <= 0) return null;
  const out: ViewRecord = { kind, at, x, y, zoom };
  const w = num(src.w);
  const h = num(src.h);
  if (w !== null && w > 0) out.w = w;
  if (h !== null && h > 0) out.h = h;
  return out;
}

export function normalizeRecords(raw: unknown): Records {
  const out: Records = {};
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const path of Object.keys(src)) {
    const rec = normalizeRecord(src[path]);
    if (rec) out[path] = rec;
  }
  return out;
}

/** 值一样就不必重写记录（`at` 不参与比较，否则每拍都算"变了"） */
export function sameRecord(
  a: ViewRecord | null | undefined,
  b: ViewRecord | null | undefined,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "pdf") {
    if (!a.pdf || !b.pdf) return false;
    if (a.pdf.fingerprint !== b.pdf.fingerprint) return false;
    return samePdfValues(a.pdf, b.pdf);
  }
  return closeViewport(a, b, 0.5, 0.002);
}

/** 路径变了（重命名）时把记录跟着搬过去 */
export function renameRecord(records: Records, oldPath: string, newPath: string): boolean {
  const rec = records[oldPath];
  if (!rec) return false;
  delete records[oldPath];
  records[newPath] = rec;
  return true;
}

export function pruneRecords(records: Records, max = MAX_RECORDS): Records {
  const keys = Object.keys(records);
  if (keys.length <= max) return records;
  keys.sort((a, b) => (num(records[b].at) ?? 0) - (num(records[a].at) ?? 0));
  const out: Records = {};
  for (const k of keys.slice(0, max)) out[k] = records[k];
  return out;
}

export function viewKey(leaf: unknown, path: string): string {
  const id =
    leaf && typeof (leaf as { id?: unknown }).id === "string" ? (leaf as { id: string }).id : "";
  return `${id}|${path}`;
}

/** 设置页用的简要描述 */
export function describeRecord(rec: ViewRecord): string {
  if (rec.kind === "pdf") {
    const p = num(rec.pdf?.page);
    return p !== null ? `第 ${p} 页` : "未读到页码";
  }
  const z = num(rec.zoom) ?? 1;
  return `缩放 ${Math.round(z * 100)}%`;
}
