/**
 * 纯逻辑层：快照的归一化、指纹，以及"这次变化能不能当真"的判定。
 *
 * 刻意不 import obsidian —— 这样能在 Node 里直接单测（见 .workbuddy/scripts/fold_memory_test.cjs）。
 */

/** 一个 vault 的折叠快照 */
export interface FoldState {
  /** 当前展开着的文件夹路径（vault 相对路径），已归一化排序 */
  expanded: string[];
  /** 记录时间戳（ms） */
  at: number;
}

export interface ChangeContext {
  /** 最近 USER_ACTIVE_MS 内有没有用户输入（点击 / 按键） */
  userActive: boolean;
  /** 是否还在"刚启动"的宽限期内 */
  withinStartupGrace: boolean;
}

export type ChangeVerdict = "save" | "suspect";

/** 启动后这段时间内发生的"缩水"一律不认 */
export const STARTUP_GRACE_MS = 5000;
/** 多久之内算"用户刚动过手" */
export const USER_ACTIVE_MS = 2000;

/** 去空、去重、排序。任何非字符串输入被静默丢掉 */
export function normalizeExpanded(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const p = raw.trim();
    if (p) seen.add(p);
  }
  return [...seen].sort();
}

/** 稳定指纹 —— 轮询时用它判断"到底变没变"，避免无意义的写盘 */
export function foldSignature(list: string[]): string {
  return normalizeExpanded(list).join("\n");
}

/** 只留下 exists() 认得的路径（文件夹被改名/删除后快照里的残留） */
export function existingOnly(list: string[], exists: (p: string) => boolean): string[] {
  return normalizeExpanded(list).filter((p) => {
    try {
      return exists(p);
    } catch {
      return false;
    }
  });
}

/** 两份快照的差异，用于日志与设置页展示 */
export function diffExpanded(prev: string[], next: string[]): { added: string[]; removed: string[] } {
  const a = new Set(normalizeExpanded(prev));
  const b = new Set(normalizeExpanded(next));
  return {
    added: [...b].filter((p) => !a.has(p)).sort(),
    removed: [...a].filter((p) => !b.has(p)).sort(),
  };
}

/**
 * 判定一次"展开状态变化"能不能当真。
 *
 * 背景：这个 bug 的症状就是**启动瞬间整棵树被收起**。如果那一刻我们把它当成
 * 用户的正常操作存下来，就等于亲手把好快照洗掉 —— 那比不修还糟。所以：
 *
 *   1. 变多 / 不变            → 存（正常使用）
 *   2. 缩水但用户刚动过手      → 存（人家自己收的）
 *   3. 启动宽限期内任何缩水    → 不认（刚开 app 就手动收起一摞，几乎不可能）
 *   4. 缩水到 0（整棵树收起）  → 不认
 *   5. 缩水 ≥ 60% 且 ≥ 3 项    → 不认
 *   6. 其它小幅缩水           → 存
 *
 * 判定为 "suspect" 时，调用方应当把它当成"丢了"，用基线重新展开，而不是保存。
 */
export function judgeChange(
  prev: string[],
  next: string[],
  ctx: ChangeContext,
): ChangeVerdict {
  const before = normalizeExpanded(prev);
  const after = normalizeExpanded(next);
  if (before.length === 0) return "save"; // 还没有基线，第一次就是基线
  if (foldSignature(before) === foldSignature(after)) return "save";

  const gone = before.length - after.length;
  if (gone <= 0) return "save";
  if (ctx.userActive) return "save";
  if (ctx.withinStartupGrace) return "suspect";
  if (after.length === 0) return "suspect";
  if (gone >= Math.max(3, Math.ceil(before.length * 0.6))) return "suspect";
  return "save";
}

/**
 * 摘要文案（设置页用）
 */
export function summarizeExpanded(list: string[], max = 5): string {
  const arr = normalizeExpanded(list);
  if (arr.length === 0) return "（无，整棵收起）";
  if (arr.length <= max) return arr.join("、");
  return `${arr.slice(0, max).join("、")} 等 ${arr.length} 个`;
}
