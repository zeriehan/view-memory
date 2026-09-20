/**
 * 引擎层：读当前展开状态 / 套用基线 / 轮询对账。
 *
 * 全部外部依赖都从 EngineHost 注入，所以这里同样不 import obsidian，
 * 可以在 Node 里配一个假 host 跑完整的回归测试。
 */
import {
  ChangeVerdict,
  FoldState,
  STARTUP_GRACE_MS,
  USER_ACTIVE_MS,
  diffExpanded,
  existingOnly,
  foldSignature,
  judgeChange,
  normalizeExpanded,
} from "./folds";

export interface EngineHost {
  /** 所有文件列表视图（一般是 0 或 1 个） */
  views(): any[];
  /** 路径是不是文件夹。item 可能为 null，此时按 vault 查 */
  isFolder(path: string, item: any): boolean;
  /** 读 Obsidian 自己那份存储里的展开项（只读，用作首次的种子） */
  readObsidianFolds(): string[];
  /** 读本插件存的快照 */
  loadSnapshot(): FoldState | null;
  /** 写本插件存的快照 */
  saveSnapshot(s: FoldState): void;
  log(...args: any[]): void;
}

export interface EngineSettings {
  /** 启动时恢复 */
  restoreOnStartup: boolean;
  /** 完全还原：把快照里没有的文件夹也收起 */
  exactRestore: boolean;
  /** 挡掉可疑的整体折叠 */
  ignoreMassCollapse: boolean;
}

export type TickResult = "idle" | "saved" | "restored" | "skipped";

export class FoldEngine {
  settings: EngineSettings;
  /** 我们认可的展开项（"应该长这样"） */
  baseline: string[] = [];
  /** 一共挡下了几次可疑的整体折叠 */
  blockedCount = 0;
  /** 恢复基线时动过多少个文件夹 */
  lastRestoredCount = 0;
  /** 只有在 arm 之后才允许保存 —— 否则会把启动瞬间的坏状态写进快照 */
  armed = false;
  applying = false;
  startedAt = 0;
  lastInputAt = 0;
  /** 上一次观察到的指纹；null = 还没观察到有效状态 */
  private lastSig: string | null = null;

  constructor(private host: EngineHost, settings: EngineSettings) {
    this.settings = settings;
  }

  private now(): number {
    return Date.now();
  }

  private log(...args: any[]): void {
    this.host.log(...args);
  }

  /** 记一次"用户刚动过手" */
  markUserInput(): void {
    this.lastInputAt = this.now();
  }

  /**
   * 读当前展开着的文件夹。
   * 口径与 Obsidian 自己的 saveFolds 完全一致：默认折叠，所以存的是"展开项"的例外集合。
   */
  readExpanded(): string[] {
    const out: string[] = [];
    for (const view of this.host.views()) {
      const items = view && view.fileItems;
      if (!items || typeof items !== "object") continue;
      for (const path of Object.keys(items)) {
        if (!Object.prototype.hasOwnProperty.call(items, path)) continue;
        const item = items[path];
        // 文件夹条目才有 collapsed；默认折叠的语义下，展开 === false
        if (!item || item.collapsed !== false) continue;
        if (!this.host.isFolder(path, item)) continue;
        out.push(path);
      }
    }
    return normalizeExpanded(out);
  }

  /**
   * 当前状态的指纹。null 表示**状态未知** —— 没有文件列表视图，或者条目还没建好。
   *
   * 这个区分很关键：启动早期 `fileItems` 是空的，如果把它当成"用户把整棵树收起来了"，
   * 就会在真正的状态出现之前一直按空状态对账，反而永远修不回来。
   */
  private currentSig(): string | null {
    for (const view of this.host.views()) {
      const items = view && view.fileItems;
      if (items && typeof items === "object" && Object.keys(items).length > 0) {
        return foldSignature(this.readExpanded());
      }
    }
    return null;
  }

  /**
   * 建基线。优先用本插件存的快照；没有就沿 Obsidian 自己那份存储（它其实是写对了的，
   * 丢状态发生在恢复环节）；再没有就用当前界面。
   */
  primeBaseline(): { source: "snapshot" | "obsidian" | "ui"; count: number } {
    const snap = this.host.loadSnapshot();
    let list = snap ? normalizeExpanded(snap.expanded) : [];
    let source: "snapshot" | "obsidian" | "ui" = "snapshot";
    if (list.length === 0) {
      const seed = normalizeExpanded(this.host.readObsidianFolds());
      if (seed.length) {
        list = seed;
        source = "obsidian";
      } else {
        list = this.readExpanded();
        source = "ui";
      }
    }
    this.baseline = existingOnly(list, (p) => this.host.isFolder(p, null));
    return { source, count: this.baseline.length };
  }

  /**
   * 把界面套成基线。
   * 只展开（安全）；开了 exactRestore 才会把快照外的也收起来。
   */
  async applyBaseline(): Promise<number> {
    if (this.applying) return 0;
    this.applying = true;
    let changed = 0;
    try {
      const want = new Set(this.baseline);
      for (const view of this.host.views()) {
        const items = view && view.fileItems;
        if (!items || typeof items !== "object") continue;
        for (const path of Object.keys(items)) {
          if (!Object.prototype.hasOwnProperty.call(items, path)) continue;
          const item = items[path];
          if (!item || !this.host.isFolder(path, item)) continue;
          const shouldExpand = want.has(path);
          if (!shouldExpand && !this.settings.exactRestore) continue;
          const target = !shouldExpand; // 在快照里 → 展开(false)；不在 → 收起(true)
          if (item.collapsed === target) continue;
          try {
            if (typeof item.setCollapsed === "function") {
              await item.setCollapsed(target, false);
            } else if (typeof item.toggleCollapsed === "function") {
              item.toggleCollapsed(false);
            } else {
              continue;
            }
            changed++;
          } catch (e) {
            this.log("设置折叠状态失败：", path, e);
          }
        }
        this.flushHostFolds(view);
      }
    } finally {
      this.applying = false;
      const sig = this.currentSig();
      if (sig !== null) this.lastSig = sig;
      this.lastRestoredCount = changed;
    }
    return changed;
  }

  /**
   * 让 Obsidian 把自己那份存储也刷新一遍（它写的就是同一个状态）。
   * 这样即使哪天这个插件没启用，宿主自己的恢复也更可能对。
   */
  private flushHostFolds(view: any): void {
    try {
      const tree = view && view.tree;
      if (!tree) return;
      if (typeof tree.requestSaveFolds === "function") tree.requestSaveFolds();
      else if (typeof tree.saveFolds === "function") tree.saveFolds();
    } catch {
      /* 内部方法，缺了就缺了 */
    }
  }

  /** 启动收尾：建基线 → 套用 → 开闸 */
  async finishStartup(): Promise<{ source: string; count: number; changed: number }> {
    this.startedAt = this.now();
    const primed = this.primeBaseline();
    let changed = 0;
    if (this.settings.restoreOnStartup) {
      changed = await this.applyBaseline();
    } else {
      // 不恢复就得认当前状态为准，否则后面的守卫会跟用户对着干
      this.baseline = this.readExpanded();
    }
    this.lastSig = this.currentSig(); // 可能还是 null（界面没就绪），交给后面的对账
    this.armed = true;
    return { source: primed.source, count: primed.count, changed };
  }

  /** 轮询对账。每次状态真的变了才做判定 */
  tick(): TickResult {
    if (!this.armed || this.applying) return "skipped";
    const sig = this.currentSig();
    if (sig === null) return "skipped"; // 状态未知（还没建好 / 没开文件列表），别乱动
    if (sig === this.lastSig) return "idle";
    const cur = this.readExpanded();

    const ctx = {
      userActive: this.lastInputAt > 0 && this.now() - this.lastInputAt < USER_ACTIVE_MS,
      withinStartupGrace: this.startedAt > 0 && this.now() - this.startedAt < STARTUP_GRACE_MS,
    };
    const verdict: ChangeVerdict = this.settings.ignoreMassCollapse
      ? judgeChange(this.baseline, cur, ctx)
      : "save";

    if (verdict === "suspect") {
      this.blockedCount++;
      const removed = diffExpanded(this.baseline, cur).removed;
      this.log(
        `疑似折叠丢失：展开项从 ${this.baseline.length} 掉到 ${cur.length}，已忽略并恢复。丢的是：`,
        removed.slice(0, 10),
      );
      void this.applyBaseline();
      return "restored";
    }

    this.baseline = cur;
    this.lastSig = sig;
    this.host.saveSnapshot({ expanded: cur, at: this.now() });
    return "saved";
  }

  /** 退出前的最后一存 */
  flushOnUnload(): string[] | null {
    if (!this.armed || this.applying) return null;
    const cur = this.readExpanded();
    const ctx = {
      userActive: this.lastInputAt > 0 && this.now() - this.lastInputAt < USER_ACTIVE_MS,
      withinStartupGrace: this.startedAt > 0 && this.now() - this.startedAt < STARTUP_GRACE_MS,
    };
    const verdict: ChangeVerdict = this.settings.ignoreMassCollapse
      ? judgeChange(this.baseline, cur, ctx)
      : "save";
    if (verdict === "suspect") {
      this.log("退出时状态可疑（可能是启动折叠丢失），不覆盖快照");
      return null;
    }
    this.host.saveSnapshot({ expanded: cur, at: this.now() });
    return cur;
  }

  /** "记住当前"命令用：无视判定，强制把当前状态定为基线 */
  rememberNow(): string[] {
    const cur = this.readExpanded();
    this.baseline = cur;
    this.lastSig = foldSignature(cur);
    this.host.saveSnapshot({ expanded: cur, at: this.now() });
    return cur;
  }
}
