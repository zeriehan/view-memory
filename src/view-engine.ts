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
  closeScroll,
  closeViewport,
  describeRecord,
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
  log(...args: unknown[]): void;
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
  /**
   * 一个视图的"恢复阶段"有多长（从它第一次就绪算起）。
   *
   * 过了这段就只记录、不再套用 —— 否则"把视图摆回记录位置"这件事会变成
   * 长期悬在头上的纠正，用户自己翻页后过一会儿又被拽回去（PDF 来回闪就是这个）。
   */
  restoreWindowMs: number;
}

export function defaultEngineSettings(): EngineSettings {
  return {
    restore: true,
    // 核心 Canvas 本来就把视窗写进 workspace.json（它的 getState 里有 viewState），
    // 默认不去碰它；真发现它也丢，把开关打开即可。
    kinds: { pdf: true, md: true, canvas: false, excalidraw: true },
    settleMs: 900,
    maxAttempts: 3,
    captureGraceMs: 2500,
    userActiveMs: 800,
    restoreWindowMs: 6000,
  };
}

interface ViewRuntime {
  firstReadyAt: number;
  attempts: number;
  appliedAt: number;
  /** 套用那一刻的实况。下一拍拿它比：实况自己变了 = 不是我们干的 = 用户在动 */
  liveAtApply: ViewRecord | null;
  /** 已交还给用户：此后只记录，绝不套用（本视图生命周期内不再复位） */
  handsOff: boolean;
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
    if (h.kind === "md") return closeScroll(h.live.scroll, rec.scroll);
    return closeViewport(h.live, rec);
  }

  private captureView(h: ViewHandle, live: ViewRecord): boolean {
    if (h.kind === "pdf" && !(live.pdf && isPdfEntryUsable(live.pdf))) return false;
    if (h.kind === "md" && (live.scroll === undefined || live.scroll < 0)) return false;
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
   *
   * ★ 另一条铁律：**一个视图只允许被"摆"一次**。套用成功（或用户碰过它）之后立刻
   * hands-off，之后实况就是唯一真相。否则"把视图摆回记录位置"会变成长期纠正 ——
   * 用户翻到下一页，过一会儿又被拽回上一页，来回闪（PDF 就是这样）。
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
        rt = { firstReadyAt: 0, attempts: 0, appliedAt: 0, liveAtApply: null, handsOff: false };
        this.states.set(h.key, rt);
      }
      if (!this.managed(h.kind)) continue;
      if (!h.ready || !h.live) continue;
      if (!rt.firstReadyAt) rt.firstReadyAt = now;
      const settled = now - rt.firstReadyAt >= this.settings.settleMs;
      const inRestoreWindow = now - rt.firstReadyAt <= this.settings.restoreWindowMs;

      // 套用之后实况自己变了 —— 不是我们干的，那就是用户（或宿主在异步落位）。
      // 再动手就是抢，从此交还给他。
      if (!rt.handsOff && rt.liveAtApply && !sameRecord(rt.liveAtApply, h.live)) {
        rt.handsOff = true;
        this.host.log("视图已被接手，不再套用：", h.path);
      }

      // 刚套用过之后的静默期：既不回读（别把宿主的异步覆盖记成用户的新位置），
      // 也不重复套用（别跟马上要尘埃落定的宿主抢）
      if (rt.appliedAt && now - rt.appliedAt < this.settings.captureGraceMs) continue;

      const rec = records[h.path];
      const wantsRestore =
        !!rec && rec.kind === h.kind && this.settings.restore && !rt.handsOff && inRestoreWindow;

      if (rec && wantsRestore) {
        if (this.isSatisfied(h, rec)) {
          rt.handsOff = true; // 已经到位，收工
        } else if (!settled) {
          continue; // 还没到动手的时候，先什么都别记
        } else if (this.userActive(now)) {
          // 该摆回来了，但你正在翻 —— 说明你已经接手，这个视图让给你（此后只记录）。
          // 注意这里**不 continue**：这一拍照常按实况记录，用户当前的位置才是最新。
          rt.handsOff = true;
          this.host.log("用户正在操作，交还视图：", h.path);
        } else if (rt.attempts < this.settings.maxAttempts) {
          rt.attempts++;
          rt.appliedAt = now;
          rt.liveAtApply = h.live;
          let done = false;
          try {
            this.host.applyRecord(h, rec);
            done = true;
          } catch (e) {
            this.host.log("套用视图状态失败：", h.path, e);
          }
          if (done) restored++;
          continue; // 同一拍里别把刚改的自己读回来
        } else {
          rt.handsOff = true; // 试够了，认了
        }
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

  /** 命令用：把记录重新套一遍（这一条是用户显式要的，多摆几次也认） */
  restoreNow(): number {
    let n = 0;
    const records = this.host.records();
    for (const h of this.host.handles()) {
      if (!this.managed(h.kind) || !h.ready || !h.live) continue;
      const rec = records[h.path];
      if (!rec || rec.kind !== h.kind) continue;
      if (this.isSatisfied(h, rec)) continue;
      const rt = this.states.get(h.key);
      if (rt) {
        // 手动恢复是明确意图：重新武装，并让"实况自己变了"那条规则从这一刻重新计时
        rt.handsOff = false;
        rt.attempts = 0;
        rt.appliedAt = this.now();
        rt.liveAtApply = h.live;
      }
      try {
        this.host.applyRecord(h, rec);
        n++;
      } catch (e) {
        this.host.log("套用视图状态失败：", h.path, e);
      }
    }
    return n;
  }

  /**
   * 设置页展示：当前打开了哪些被管理的视图、各自什么状态。
   *
   * 带上「记录 / 实况 / 是否已交还 / 试了几次」—— 出问题时一眼能分清是
   * 「压根没套」（两者不同且 attempts=0）、「套了但宿主没照做」（attempts>0 且实况没变）
   * 还是「套成功了之后用户又动了」（handsOff）。
   */
  viewReport(): ViewReport[] {
    const records = this.host.records();
    return this.host.handles().map((h) => {
      const rt = this.states.get(h.key);
      const rec = records[h.path];
      return {
        path: h.path,
        kind: h.kind,
        ready: !!h.ready,
        managed: this.managed(h.kind),
        record: rec ? describeRecord(rec) : "",
        live: h.live ? describeRecord(h.live) : "",
        handsOff: !!rt?.handsOff,
        attempts: rt?.attempts ?? 0,
      };
    });
  }
}

export interface ViewReport {
  path: string;
  kind: ViewKind;
  ready: boolean;
  managed: boolean;
  /** 记录里记的位置（人话） */
  record: string;
  /** 当前实况（人话） */
  live: string;
  /** 是否已交还给用户（此后只记录不套用） */
  handsOff: boolean;
  /** 这个视图一共套用过几次 */
  attempts: number;
}
