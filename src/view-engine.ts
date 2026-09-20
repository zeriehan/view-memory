/**
 * 引擎层：一拍一拍地检查所有打开的视图 —— 该恢复的恢复，该记录的就记录。
 *
 * 所有外部依赖从 EngineHost 注入，这里同样不 import obsidian，
 * 可以配假 host 在 Node 里把"打开 → 恢复 → 记录"整条链路跑一遍。
 */
import {
  Records,
  ViewKind,
  ViewRecord,
  closeViewport,
  isPdfEntryUsable,
  sameRecord,
} from "./state";

export interface ViewHandle {
  /** 同一份文件可能同时开在两个叶子，所以 key 是「叶子 + 路径」 */
  key: string;
  path: string;
  kind: ViewKind;
  /** 文档加载到能读写视窗的程度了吗 */
  ready: boolean;
  /** 当前实况；ready 为 false 时是 null */
  live: ViewRecord | null;
}

export interface EngineHost {
  handles(): ViewHandle[];
  records(): Records;
  putRecord(path: string, rec: ViewRecord): void;
  /** 把记录套到某个视图上（宿主知道怎么操作具体的视图对象） */
  applyRecord(h: ViewHandle, rec: ViewRecord): void;
  /** 每次 tick 都调：把 pdf.js 那张共享表对平（多开时互相覆盖就出在这） */
  reconcilePdf(): void;
  /** 有改动时调，宿主自己防抖落盘 */
  flush(): void;
  log(...args: any[]): void;
}

export interface EngineSettings {
  /** 总开关：关掉就只记录、不恢复 */
  restore: boolean;
  /** 每个类型管不管 */
  kinds: Record<ViewKind, boolean>;
  /** 视图就绪后再等这么久才动手，让宿主自己的初始化先跑完 */
  settleMs: number;
  /** 最多校正几次；还不对就认了，免得反复抢 */
  maxAttempts: number;
  /** 刚套用过之后的静默期：这段时间不回读，也不重复套用 */
  captureGraceMs: number;
  /**
   * 用户刚操作过的时间窗。窗口内一律不去改视图 ——
   * 打开 PDF 的瞬间你可能已经在滚了，那会儿把你拽回旧页码是最讨嫌的行为。
   */
  userActiveMs: number;
}

export function defaultEngineSettings(): EngineSettings {
  return {
    restore: true,
    // 核心 Canvas 本来就把视窗写进 workspace.json（它的 getState 里有 viewState），
    // 默认不去碰它；真发现它也丢，把开关打开即可。
    kinds: { pdf: true, canvas: false, excalidraw: true },
    settleMs: 900,
    maxAttempts: 3,
    captureGraceMs: 2500,
    userActiveMs: 800,
  };
}

interface ViewRuntime {
  firstReadyAt: number;
  attempts: number;
  appliedAt: number;
}

export interface TickStats {
  restored: number;
  captured: number;
}

export class ViewMemoryEngine {
  settings: EngineSettings;
  /** 上一次 tick 的统计，设置页展示用 */
  last: TickStats = { restored: 0, captured: 0 };
  lastTickAt = 0;
  private states = new Map<string, ViewRuntime>();
  private dirty = false;
  private lastInputAt = 0;

  constructor(private host: EngineHost, settings: EngineSettings) {
    this.settings = settings;
  }

  /** 用户点了/敲了/滚了 —— 记一下，短时间内别去动他的视图 */
  markUserInput(): void {
    this.lastInputAt = Date.now();
  }

  private userActive(now: number): boolean {
    return this.lastInputAt > 0 && now - this.lastInputAt < this.settings.userActiveMs;
  }

  private managed(kind: ViewKind): boolean {
    return this.settings.kinds[kind] !== false;
  }

  private now(): number {
    return Date.now();
  }

  /** 当前实况是不是已经等于记录（等于就不必再动它） */
  private isSatisfied(h: ViewHandle, rec: ViewRecord): boolean {
    if (!h.live) return false;
    if (h.kind === "pdf") {
      const want = rec.pdf;
      const got = h.live.pdf;
      // 记录里没有有效页码 → 没什么可纠正的
      if (!isPdfEntryUsable(want)) return true;
      if (!got) return false;
      return got.page === want.page;
    }
    return closeViewport(h.live, rec);
  }

  private captureView(h: ViewHandle, live: ViewRecord): boolean {
    if (h.kind === "pdf" && !(live.pdf && isPdfEntryUsable(live.pdf))) return false;
    const old = this.host.records()[h.path];
    if (sameRecord(old, live)) return false;
    this.host.putRecord(h.path, { ...live, at: this.now() });
    this.dirty = true;
    return true;
  }

  /**
   * 一拍。
   *
   * 顺序很重要：先判"要不要恢复"，再判"要不要记录"。
   * 反过来的话，启动瞬间视图还是默认视窗，就会把默认值当成用户的新位置记下来。
   */
  tick(): TickStats {
    const now = this.now();
    this.lastTickAt = now;
    const handles = this.host.handles();
    const alive = new Set<string>();
    const records = this.host.records();
    let restored = 0;
    let captured = 0;

    for (const h of handles) {
      alive.add(h.key);
      let rt = this.states.get(h.key);
      if (!rt) {
        rt = { firstReadyAt: 0, attempts: 0, appliedAt: 0 };
        this.states.set(h.key, rt);
      }
      if (!this.managed(h.kind)) continue;
      if (!h.ready || !h.live) continue;
      if (!rt.firstReadyAt) rt.firstReadyAt = now;
      const settled = now - rt.firstReadyAt >= this.settings.settleMs;

      // 刚动过手：整段静默。这段时间既不回读（别把宿主的异步覆盖记成用户的新位置），
      // 也不重复套用（别跟马上要尘埃落定的宿主抢）
      if (rt.appliedAt && now - rt.appliedAt < this.settings.captureGraceMs) continue;

      const rec = records[h.path];
      if (rec && rec.kind === h.kind && this.settings.restore) {
        const ok = this.isSatisfied(h, rec);
        const handsOff = this.userActive(now);
        if (!ok && !handsOff && settled && rt.attempts < this.settings.maxAttempts) {
          rt.attempts++;
          rt.appliedAt = now;
          let done = false;
          try {
            this.host.applyRecord(h, rec);
            done = true;
          } catch (e) {
            this.host.log("套用视图状态失败：", h.path, e);
          }
          if (done) restored++;
          continue; // 同一拍里别把刚改的自己读回来
        }
        // 还没到动手的时候，先什么都别记
        if (!settled) continue;
      } else if (!settled) {
        continue;
      }

      if (this.captureView(h, h.live)) captured++;
    }

    // 视图关掉后把运行态一起扔掉，不然 map 会一直长
    for (const k of Array.from(this.states.keys())) {
      if (!alive.has(k)) this.states.delete(k);
    }

    try {
      this.host.reconcilePdf();
    } catch (e) {
      this.host.log("对平 PDF 记录失败：", e);
    }

    if (this.dirty) {
      this.dirty = false;
      this.host.flush();
    }

    this.last = { restored, captured };
    return this.last;
  }

  /** 退出前最后一拍：记下来 + 落盘 */
  finish(): void {
    try {
      this.tick();
    } catch (e) {
      this.host.log("退出前记录失败：", e);
    }
    this.host.flush();
  }

  /** 命令用：无视判定，把当前所有视图的位置立刻记下来 */
  rememberNow(): number {
    let n = 0;
    for (const h of this.host.handles()) {
      if (!this.managed(h.kind) || !h.ready || !h.live) continue;
      if (this.captureView(h, h.live)) n++;
    }
    if (this.dirty) {
      this.dirty = false;
      this.host.flush();
    }
    return n;
  }

  /** 命令用：把记录重新套一遍 */
  restoreNow(): number {
    let n = 0;
    const records = this.host.records();
    for (const h of this.host.handles()) {
      if (!this.managed(h.kind) || !h.ready || !h.live) continue;
      const rec = records[h.path];
      if (!rec || rec.kind !== h.kind) continue;
      if (this.isSatisfied(h, rec)) continue;
      try {
        this.host.applyRecord(h, rec);
        n++;
      } catch (e) {
        this.host.log("套用视图状态失败：", h.path, e);
      }
    }
    return n;
  }

  /** 设置页展示：当前打开了哪些被管理的视图、各自什么状态 */
  viewReport(): { path: string; kind: ViewKind; ready: boolean; managed: boolean }[] {
    return this.host.handles().map((h) => ({
      path: h.path,
      kind: h.kind,
      ready: !!h.ready,
      managed: this.managed(h.kind),
    }));
  }
}
