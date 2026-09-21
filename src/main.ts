/**
 * 记忆助手 —— 宿主适配层。
 *
 * 一个插件管两件本就同构的事：
 *   ① 文件列表的展开状态（fold）
 *   ② 阅读位置与画布视窗（view）
 * 两边都是「纯函数层 + 引擎层 + 宿主适配层」的三层结构，引擎不依赖 obsidian，
 * 所以能在 Node 里配假 host 把整条链路跑一遍。
 *
 * 这里只做三件该做的事：把 Obsidian 的内部对象读成引擎认得的样子、把引擎的决定
 * 套回 Obsidian、渲染设置页。判定逻辑一行都不在这里。
 */
import * as fs from "fs";
import * as path from "path";
import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { EngineHost as FoldHost, FoldEngine } from "./fold-engine";
import { FoldState, normalizeExpanded } from "./folds";
import {
  EngineHost as ViewHost,
  EngineSettings as ViewEngineSettings,
  ViewHandle,
  ViewMemoryEngine,
  ViewReport,
  defaultEngineSettings,
} from "./view-engine";
import {
  MAX_RECORDS,
  PDF_HISTORY_KEY,
  PdfEntry,
  Records,
  ViewKind,
  ViewRecord,
  describeRecord,
  isPdfEntryUsable,
  mergePdfHistory,
  normalizeRecords,
  num,
  pageHashForEntry,
  parsePdfHistory,
  pdfEntriesFromRecords,
  pruneRecords,
  renameRecord,
  serializePdfHistory,
  viewKey,
} from "./state";
import {
  AdapterLike,
  CanvasLike,
  CanvasViewStateLike,
  ExcalidrawApiLike,
  ExcalidrawAppStateLike,
  ExplorerViewLike,
  LeafViewLike,
  LocalStorageAppLike,
  PdfStoreLike,
  PdfViewerAppLike,
  PdfViewHostLike,
} from "./internals";
import { MemorySettingTab } from "./settings";

/** 折叠那半边的配置 */
export interface FoldSettings {
  /** 这半边要不要管 */
  enabled: boolean;
  /** vault 名 → 快照 */
  byVault: Record<string, FoldState>;
  restoreOnStartup: boolean;
  exactRestore: boolean;
  ignoreMassCollapse: boolean;
}

/** 视窗那半边的配置（引擎参数直接平铺在里头，和引擎共享同一个引用） */
export interface ViewSettings extends ViewEngineSettings {
  /** 这半边要不要管 */
  enabled: boolean;
  records: Records;
}

export interface MemorySettings {
  fold: FoldSettings;
  view: ViewSettings;
  debug: boolean;
  /** 旧的两个插件（fold-memory / view-memory）的记录搬过一次就够了 */
  migrated?: boolean;
}

/** 深拷贝默认值：浅拷贝会让数组/对象默认值与常量共享引用（踩过两次） */
function defaultSettings(): MemorySettings {
  return JSON.parse(
    JSON.stringify({
      fold: {
        enabled: true,
        byVault: {},
        restoreOnStartup: true,
        exactRestore: false,
        ignoreMassCollapse: true,
      },
      view: {
        enabled: true,
        ...defaultEngineSettings(),
        records: {},
      },
      debug: false,
      migrated: false,
    }),
  ) as MemorySettings;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * 视图类型 → Obsidian 的 **leaf 类型**。
 *
 * ★ 两者**不是一回事**：Markdown 的 leaf 类型叫 `"markdown"`，不叫 `"md"`。
 * 直接拿 `kind` 去 `getLeavesOfType()` 就会查不到任何叶子 —— 而 `leafOf()` 查不到
 * 叶子只会安静地 `return null`，于是表现成「记录存下来了，但永远套不回去」，
 * 不报错、不写日志，最难查。所以**凡是要按类型找叶子/遍历叶子，都走这张表**。
 */
const LEAF_TYPE: Record<ViewKind, string> = {
  pdf: "pdf",
  md: "markdown",
  canvas: "canvas",
  excalidraw: "excalidraw",
};

export default class ObsidianMemoryPlugin extends Plugin {
  settings: MemorySettings;
  private foldEngine: FoldEngine;
  private viewEngine: ViewMemoryEngine;

  private booted = false;
  private deferIds: number[] = [];
  private reconcileId: number | null = null;
  private foldFlushId: number | null = null;
  private viewFlushId: number | null = null;
  /** 最近一次写进 localStorage 的那张表；用来避免每拍重复写盘 */
  private pdfTableKey = "";
  private pdfTable: PdfEntry[] | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.migrateLegacy();

    // 启动时先留一行，包含版本号 —— 排查"到底有没有生效"时，先看这行能确定跑的是哪版
    this.log(
      `view-memory ${this.manifest.version} 启动`,
      `接管=${JSON.stringify(this.settings.view.kinds)}`,
      `恢复=${this.settings.view.restore}`,
      `就绪等待=${this.settings.view.settleMs}ms`,
      `恢复窗口=${this.settings.view.restoreWindowMs}ms`,
      `最多套用=${this.settings.view.maxAttempts}次`,
      `已有记录 ${Object.keys(this.settings.view.records).length} 条`,
    );

    // ── 折叠侧 ────────────────────────────────────────────
    // 注意：settings.fold 是**同一个对象引用**交给引擎的，所以 loadSettings
    // 必须原地改而不能整个替换，否则引擎读到的还是旧的。
    const foldHost: FoldHost = {
      views: () => this.foldViews(),
      isFolder: (p, item) => {
        const f: unknown = item?.file ?? this.app.vault.getAbstractFileByPath(p);
        return f instanceof TFolder;
      },
      readObsidianFolds: () => this.readObsidianFolds(),
      loadSnapshot: () => this.snapshot(),
      saveSnapshot: (s) => this.putSnapshot(s),
      log: (...a) => this.log(...a),
    };
    this.foldEngine = new FoldEngine(foldHost, this.settings.fold);

    // ── 视窗侧 ────────────────────────────────────────────
    const viewHost: ViewHost = {
      handles: () => this.handles(),
      records: () => this.settings.view.records,
      putRecord: (p, rec) => {
        this.settings.view.records[p] = rec;
      },
      applyRecord: (h, rec) => this.applyRecord(h, rec),
      reconcilePdf: () => this.reconcilePdf(),
      flush: () => this.flushView(),
      log: (...a) => this.log(...a),
    };
    this.viewEngine = new ViewMemoryEngine(viewHost, this.settings.view);

    // ── 一个定时器，两边各跑各的一拍 ───────────────────────
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.fold.enabled) this.foldEngine.tick();
        if (this.settings.view.enabled) this.viewEngine.tick();
      }, 1000),
    );

    // ── 用户刚动过手的信号 ────────────────────────────────
    // 折叠侧「宽口径」：点哪儿都算 —— 它只需要知道"人正在操作界面"。
    const foldInput = () => this.foldEngine.markUserInput();
    const foldEvents: (keyof DocumentEventMap)[] = [
      "click",
      "keydown",
      "wheel",
      "touchstart",
      "scroll",
    ];
    for (const ev of foldEvents) {
      this.registerDomEvent(document, ev, foldInput, true);
    }
    // 视窗侧必须「窄口径」，两条限制缺一不可：
    //  ① 只认真正表达"我在滚 / 我在敲"的事件。click 与 scroll **不能收** —— 宿主自己异步
    //     摆位置（md 渲染完成后把滚动位置摆好、pdf.js 自己去读那张表）同样会触发它们；
    //     收进来就会把"宿主在落位"误判成"用户已接手"，然后永久交还、再也不恢复。
    //  ② 事件必须落在这个视图自己的容器里 —— 否则点一下侧边栏也成了"用户接管了这篇笔记"。
    const viewInput = (ev: Event) => {
      const t = ev.target as Node | null;
      if (!t) return;
      for (const leaf of this.viewLeaves()) {
        const c = leaf.view?.containerEl;
        if (c && c.contains(t)) {
          this.viewEngine.markUserInput();
          return;
        }
      }
    };
    const viewEvents: (keyof DocumentEventMap)[] = [
      "wheel",
      "touchstart",
      "touchmove",
      "pointerdown",
      "keydown",
    ];
    for (const ev of viewEvents) {
      this.registerDomEvent(document, ev, viewInput, true);
    }
    // 正常退出时记最后一拍（Obsidian 不保证一定调 onunload）
    this.registerDomEvent(window, "beforeunload", () => this.finishAll());

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.settings.fold.enabled) this.scheduleFoldReconcile([300, 1200, 3000]);
        if (this.settings.view.enabled) this.scheduleViewTick([250, 1000, 2500]);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.settings.view.enabled) this.scheduleViewTick([120, 600]);
      }),
    );

    // 打开文件时抢在 pdf.js 读存储之前把我们的记录写回去 —— 这样它自己就能恢复对
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.view.enabled) return;
        if (file instanceof TFile && this.settings.view.kinds.pdf) this.preparePdfFor(file.path);
        // Markdown 没有"自己的存储"可以先写，只能等它渲染完再把滚动位置摆回去，
        // 所以这里补几拍（引擎那边只会在恢复窗口内、且用户没接手时动手）
        if (file instanceof TFile && this.settings.view.kinds.md) {
          this.scheduleViewTick([250, 600, 1300, 2600]);
        }
      }),
    );

    // 文件改名/删除时把记录跟着搬 —— 记录是按路径存的，不搬就丢了
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const to = file.path;
        if (renameRecord(this.settings.view.records, oldPath, to)) {
          this.log(`记录随改名迁移：${oldPath} → ${to}`);
          this.flushView();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFile)) return;
        if (this.settings.view.records[file.path]) {
          delete this.settings.view.records[file.path];
          this.flushView();
        }
      }),
    );

    // ── 命令（两边各一组，名字上都带了是哪半边） ────────────
    this.addCommand({
      id: "fold-restore",
      name: "文件列表：恢复到上次的展开状态",
      callback: () => void this.foldRestore(),
    });
    this.addCommand({
      id: "fold-remember",
      name: "文件列表：把当前展开状态记为基准",
      callback: () => void this.foldRemember(),
    });
    this.addCommand({
      id: "fold-clear",
      name: "文件列表：清除这个 vault 的展开记录",
      callback: () => void this.foldClear(),
    });
    this.addCommand({
      id: "view-remember",
      name: "阅读位置：把当前视图位置记为基准",
      callback: () => void this.viewRemember(),
    });
    this.addCommand({
      id: "view-restore",
      name: "阅读位置：回到记录的阅读位置 / 视窗",
      callback: () => void this.viewRestore(),
    });
    this.addCommand({
      id: "view-clear",
      name: "阅读位置：清除这个 vault 的位置记录",
      callback: () => void this.viewClear(),
    });

    this.addSettingTab(new MemorySettingTab(this.app, this));

    // 布局就绪时这个回调会立刻同步执行；刚启动时还没就绪
    this.app.workspace.onLayoutReady(() => void this.bootstrap());
  }

  onunload(): void {
    void this.unloadCleanup();
  }

  private async unloadCleanup(): Promise<void> {
    for (const id of this.deferIds) window.clearTimeout(id);
    this.deferIds = [];
    if (this.reconcileId !== null) {
      window.clearTimeout(this.reconcileId);
      this.reconcileId = null;
    }
    if (this.foldFlushId !== null) {
      window.clearTimeout(this.foldFlushId);
      this.foldFlushId = null;
    }
    if (this.viewFlushId !== null) {
      window.clearTimeout(this.viewFlushId);
      this.viewFlushId = null;
    }
    if (this.foldEngine) {
      const kept = this.foldEngine.flushOnUnload();
      if (kept) this.log(`退出前保存展开快照（${kept.length} 项）`);
    }
    if (this.viewEngine) this.viewEngine.finish();
    await this.saveSettings();
  }

  // ══════════ 折叠侧：宿主细节 ══════════════════════════════

  private foldViews(): ExplorerViewLike[] {
    const out: ExplorerViewLike[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const v = leaf.view as unknown as ExplorerViewLike;
      if (v && v.fileItems) out.push(v);
    }
    return out;
  }

  /** Obsidian 把展开状态存在 localStorage（键 `file-explorer-unfold`，宿主自动加 vault 前缀） */
  private readObsidianFolds(): string[] {
    try {
      const raw = (this.app as unknown as LocalStorageAppLike).loadLocalStorage?.(
        "file-explorer-unfold",
      );
      return normalizeExpanded(raw);
    } catch (e) {
      this.log("读 Obsidian 自带折叠存储失败", e);
      return [];
    }
  }

  vaultKey(): string {
    try {
      return this.app.vault.getName();
    } catch {
      return "unknown";
    }
  }

  private snapshot(): FoldState | null {
    const s = this.settings.fold.byVault[this.vaultKey()];
    if (!s || !Array.isArray(s.expanded)) return null;
    return s;
  }

  private putSnapshot(s: FoldState): void {
    this.settings.fold.byVault[this.vaultKey()] = s;
    this.flushFold();
  }

  /** 等文件列表把条目建出来 —— 大库上 fileItems 是陆续填的，太早对账等于对着空状态干活 */
  private async waitForExplorer(maxMs = 6000): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      const ready = this.foldViews().some(
        (v) => v.fileItems && Object.keys(v.fileItems).length > 0,
      );
      if (ready) return true;
      if (Date.now() - t0 >= maxMs) return false;
      await sleep(150);
    }
  }

  private async bootstrap(): Promise<void> {
    if (this.booted) return;
    this.booted = true;

    if (this.settings.fold.enabled) {
      // 让 Obsidian 自己的 loadFolds 先跑完，别跟它抢；同时等条目建好
      await sleep(400);
      const ready = await this.waitForExplorer();
      if (!ready) {
        this.log("文件列表迟迟没就绪（可能没打开），先记基线，交给后续对账");
      }
      const r = await this.foldEngine.finishStartup();
      this.log(
        `折叠侧启动完成：基线来自 ${r.source}，共 ${r.count} 项，本次恢复了 ${r.changed} 个文件夹`,
      );
      if (r.changed > 0 && this.settings.debug) {
        new Notice(`文件列表展开状态已恢复（${r.changed} 个文件夹）。`);
      }
      // 有些环境里它自己的 loadFolds 会晚于我们执行，过几秒再对几次账
      this.scheduleFoldReconcile([1500, 4000, 8000, 15000]);
    }

    if (this.settings.view.enabled) {
      this.scheduleViewTick([600, 1500, 3500, 8000]);
    }
  }

  private scheduleFoldReconcile(delays: number[]): void {
    for (const d of delays) {
      this.deferIds.push(
        window.setTimeout(() => {
          if (this.foldEngine && this.foldEngine.armed) this.foldEngine.tick();
        }, d),
      );
    }
    if (this.deferIds.length > 64) this.deferIds = this.deferIds.slice(-32);
  }

  async foldRestore(): Promise<void> {
    if (!this.settings.fold.enabled) {
      new Notice("文件列表折叠记忆当前是关着的。");
      return;
    }
    if (!this.foldEngine.armed) {
      const r = await this.foldEngine.finishStartup();
      new Notice(`已恢复（${r.changed} 个文件夹）。`);
      return;
    }
    const n = await this.foldEngine.applyBaseline();
    new Notice(n ? `已恢复 ${n} 个文件夹的展开状态。` : "展开状态本来就是对的，没动。");
  }

  async foldRemember(): Promise<void> {
    const n = this.foldEngine.rememberNow();
    await this.saveSettings();
    new Notice(`已记住当前的 ${n.length} 个展开文件夹。`);
  }

  async foldClear(): Promise<void> {
    delete this.settings.fold.byVault[this.vaultKey()];
    await this.saveSettings();
    new Notice("已清除这个 vault 的展开状态记录。");
  }

  // ══════════ 视窗侧：读实况 ════════════════════════════════

  /**
   * PDF 视图的内部结构（从 1.13.7 的包里读出来的）：
   *   view.viewer(T1 包装组件) → .child(x1) → .pdfViewer = PDFViewerApplication
   *     ├ .pdfViewer  = pdf.js 的 PDFViewer（页码/缩放/滚动容器）
   *     ├ .store      = ViewHistory（就是它把阅读位置写进 localStorage）
   *     └ .pdfDocument
   */
  private pdfApp(leaf: WorkspaceLeaf): PdfViewerAppLike | null {
    const v = leaf.view as unknown as PdfViewHostLike;
    const wrapper = v && v.viewer;
    const core = wrapper && wrapper.child;
    const app = core && core.pdfViewer;
    return app && app.pdfViewer ? app : null;
  }

  private excalidrawLive(api: ExcalidrawApiLike): ViewRecord | null {
    let st: ExcalidrawAppStateLike | null = null;
    try {
      st = api.getAppState?.();
    } catch {
      return null;
    }
    if (!st) return null;
    const x = num(st.scrollX);
    const y = num(st.scrollY);
    const zoomRaw =
      st.zoom && typeof st.zoom === "object"
        ? (st.zoom as { value?: unknown }).value
        : st.zoom;
    const zoom = num(zoomRaw);
    if (x === null || y === null || zoom === null || zoom <= 0) return null;
    const rec: ViewRecord = { kind: "excalidraw", at: Date.now(), x, y, zoom };
    const w = num(st.width);
    const h = num(st.height);
    if (w !== null) rec.w = w;
    if (h !== null) rec.h = h;
    return rec;
  }

  private canvasLive(c: CanvasLike): ViewRecord | null {
    let st: CanvasViewStateLike | null = null;
    try {
      st = c.getState?.();
    } catch {
      return null;
    }
    if (!st) return null;
    const x = num(st.x);
    const y = num(st.y);
    const zoom = num(st.zoom);
    if (x === null || y === null || zoom === null || zoom <= 0) return null;
    return { kind: "canvas", at: Date.now(), x, y, zoom };
  }

  /**
   * Markdown 的滚动位置。取的是 `currentMode.getScroll()` —— 无论是源码模式还是
   * 预览模式，它都返回**小数行号**（不是像素），两种模式同量纲。
   */
  private mdLive(v: LeafViewLike): ViewRecord | null {
    const mode = v.currentMode;
    if (!mode || typeof mode.getScroll !== "function") return null;
    let raw: number | null = null;
    try {
      raw = num(mode.getScroll());
    } catch {
      return null;
    }
    if (raw === null || raw < 0) return null;
    return { kind: "md", at: Date.now(), scroll: raw };
  }

  /** 可能被接管的全部叶子（四种类型）。判断输入事件落在哪个视图里时用 */
  private viewLeaves(): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    for (const kind of Object.keys(LEAF_TYPE) as ViewKind[]) {
      for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE[kind])) out.push(leaf);
    }
    return out;
  }

  private handles(): ViewHandle[] {
    const out: ViewHandle[] = [];
    const push = (leaf: WorkspaceLeaf, kind: ViewKind, ready: boolean, live: ViewRecord | null) => {
      const p = (leaf.view as unknown as LeafViewLike)?.file?.path;
      if (typeof p !== "string" || !p) return;
      out.push({ key: viewKey(leaf, p), path: p, kind, ready, live });
    };

    for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE.pdf)) {
      const app = this.pdfApp(leaf);
      const entry = app && app.store && app.store.file;
      const ready = !!(app && app.pdfViewer && app.pdfViewer.pagesCount > 0 && entry);
      push(leaf, "pdf", ready, ready ? { kind: "pdf", at: Date.now(), pdf: { ...entry } } : null);
    }

    for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE.excalidraw)) {
      const v = leaf.view as unknown as LeafViewLike;
      // 侧边栏那个 excalidraw-sidepanel 是另一种视图，不是画布本身
      if (!v || v.getViewType?.() !== "excalidraw") continue;
      const ready = !!(v._loaded && v.excalidrawAPI && v.excalidrawData);
      push(leaf, "excalidraw", ready, ready ? this.excalidrawLive(v.excalidrawAPI) : null);
    }

    for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE.canvas)) {
      const v = leaf.view as unknown as LeafViewLike;
      const c = v && v.canvas;
      const ready = !!(c && typeof c.getState === "function");
      push(leaf, "canvas", ready, ready ? this.canvasLive(c) : null);
    }

    for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE.md)) {
      const v = leaf.view as unknown as LeafViewLike;
      const live = v ? this.mdLive(v) : null;
      push(leaf, "md", !!live, live);
    }

    return out;
  }

  private leafOf(h: ViewHandle): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType(LEAF_TYPE[h.kind])) {
      const p = (leaf.view as unknown as LeafViewLike)?.file?.path;
      if (typeof p === "string" && viewKey(leaf, p) === h.key) return leaf;
    }
    return null;
  }

  // ══════════ 视窗侧：套回去 ════════════════════════════════

  private applyRecord(h: ViewHandle, rec: ViewRecord): void {
    const leaf = this.leafOf(h);
    if (!leaf) {
      // 别静默返回：1.2.1 那次"md 恢复完全没动"就是这里悄悄 return（拿 "md" 去查叶子，
      // 而宿主那边叫 "markdown"），外面看不出任何异常。
      this.log(`套用失败：找不到对应的视图（${h.kind}）${h.path}`);
      return;
    }
    if (h.kind === "pdf") this.applyPdf(leaf, rec);
    else if (h.kind === "md") this.applyMarkdown(leaf, rec);
    else if (h.kind === "excalidraw") this.applyExcalidraw(leaf, rec);
    else this.applyCanvas(leaf, rec);
  }

  /**
   * Markdown：把滚动位置摆回去。
   *
   * ★ 必须走宿主自己的路（`MarkdownView.setEphemeralState({ scroll })`）：
   * 预览模式的 `renderer.applyScroll()` 在**文本还没渲染完 / 段落还没测量**时会
   * **安静地 `return false`**（什么都不做、也不报错），所以直接调它经常等于没调。
   * 而 `setEphemeralState({ scroll })` 内部会转成 `applyScrollDelayed` —— 先试一次，
   * 不成就在 `onRendered` 之后再来一次。Obsidian 自己切换源码/预览模式用的就是这条路。
   * 另外它会把值记进 `view.scroll`，随后进 leaf state，宿主重启时也能自己恢复。
   */
  private applyMarkdown(leaf: WorkspaceLeaf, rec: ViewRecord): void {
    const want = num(rec.scroll);
    if (want === null || want < 0) return;
    const v = leaf.view as unknown as LeafViewLike;
    const mode = v && v.currentMode;
    if (!mode) return;

    let via = "无";
    if (typeof v.setEphemeralState === "function") {
      try {
        v.setEphemeralState({ scroll: want });
        via = "setEphemeralState";
      } catch (e) {
        this.log("套用 Markdown 滚动位置失败（setEphemeralState）", e);
      }
    }
    // 兜底：某些版本/模式下 ① 不生效，再直接调一次模式自己的 applyScroll
    if (typeof mode.applyScroll === "function") {
      try {
        mode.applyScroll(want);
        if (via === "无") via = "applyScroll";
      } catch (e) {
        this.log("套用 Markdown 滚动位置失败（applyScroll）", e);
      }
    }

    // 读回一次：渲染没完成时上面两下都是"安静地不做"，日志里得能看见
    let after: number | null = null;
    try {
      after = num(mode.getScroll?.());
    } catch {
      /* 读不到就算了 */
    }
    this.log(
      `套用 Markdown 位置：想 ${want.toFixed(2)}，立刻读回 ${after === null ? "读不到" : after.toFixed(2)}（走 ${via}）`,
    );
  }

  private applyPdf(leaf: WorkspaceLeaf, rec: ViewRecord): void {
    const want = rec.pdf;
    if (!want || !want.fingerprint) return;
    // ① 写回 pdf.js 自己的存储：下次打开由它自己恢复，连页内滚动位置一起
    const disk = parsePdfHistory(this.readPdfHistoryRaw()).files;
    const merged = mergePdfHistory(disk, [{ ...want }], []);
    const key = serializePdfHistory(merged.files);
    if (key !== this.pdfTableKey) {
      this.writePdfHistoryRaw(key);
      this.pdfTableKey = key;
      this.pdfTable = merged.files;
    }
    // ② 把打开着的那个 store 也绑到新表上。
    //    不绑的话它手里那份旧快照下一拍就会把旧页码写回去 —— 这正是原 bug。
    const app = this.pdfApp(leaf);
    const store = app && app.store;
    if (store && this.pdfTable) {
      const entry = this.pdfTable.find((e) => e.fingerprint === want.fingerprint);
      if (entry) {
        try {
          store.file = entry;
          store.database = { files: this.pdfTable };
        } catch (e) {
          this.log("绑定 PDF 存储失败", e);
        }
      }
    }
    // ③ 当场也跳过去（不给宿主"下次再说"的机会）
    const hash = pageHashForEntry(want);
    if (hash) {
      try {
        (leaf.view as unknown as LeafViewLike).setEphemeralState?.({ subpath: hash });
      } catch (e) {
        this.log("跳转页码失败", e);
      }
    }
  }

  private applyExcalidraw(leaf: WorkspaceLeaf, rec: ViewRecord): void {
    const v = leaf.view as unknown as LeafViewLike;
    const api = v && v.excalidrawAPI;
    if (!api) return;
    // 挡住 Excalidraw 插件自己的「打开时缩放以适应」（zoomToFitOnOpen 默认是开的），
    // 不然我们套上去的视窗马上又被它 fit 回全图
    try {
      v.preventAutozoom?.();
    } catch {
      /* 老版本没有就跳过 */
    }
    const appState = { scrollX: rec.x, scrollY: rec.y, zoom: { value: rec.zoom } };
    try {
      api.updateScene?.({ appState });
      return;
    } catch {
      /* 换个 API 再试 */
    }
    try {
      api.setViewport?.({ scrollX: rec.x, scrollY: rec.y, zoom: rec.zoom });
    } catch (e) {
      this.log("套用 Excalidraw 视窗失败", e);
    }
  }

  private applyCanvas(leaf: WorkspaceLeaf, rec: ViewRecord): void {
    const c = (leaf.view as unknown as LeafViewLike)?.canvas;
    if (!c || typeof c.setState !== "function") return;
    try {
      c.setState({ x: rec.x, y: rec.y, zoom: rec.zoom });
    } catch (e) {
      this.log("套用 Canvas 视窗失败", e);
    }
  }

  // ══════════ pdf.js 那张共享表 ═════════════════════════════

  private readPdfHistoryRaw(): string | null {
    try {
      return window.localStorage.getItem(PDF_HISTORY_KEY);
    } catch (e) {
      this.log("读 pdfjs.history 失败", e);
      return null;
    }
  }

  private writePdfHistoryRaw(json: string): void {
    try {
      window.localStorage.setItem(PDF_HISTORY_KEY, json);
    } catch (e) {
      this.log("写 pdfjs.history 失败", e);
    }
  }

  private pdfInputs(): {
    disk: PdfEntry[];
    fromRecords: PdfEntry[];
    live: PdfEntry[];
    stores: { fp: string; store: PdfStoreLike }[];
  } {
    const disk = parsePdfHistory(this.readPdfHistoryRaw()).files;
    const fromRecords = pdfEntriesFromRecords(this.settings.view.records);
    const live: PdfEntry[] = [];
    const stores: { fp: string; store: PdfStoreLike }[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const app = this.pdfApp(leaf);
      const store = app && app.store;
      const entry = store && store.file;
      if (!store || !entry) continue;
      const fp = typeof entry.fingerprint === "string" ? entry.fingerprint : "";
      if (!fp) continue;
      live.push({ ...entry });
      stores.push({ fp, store });
    }
    return { disk, fromRecords, live, stores };
  }

  /**
   * 把 pdf.js 那张表对平，并让**所有打开的 PDF 视图共用同一张表**。
   *
   * 原 bug：每个 PDF 视图各持一份"打开那一刻"的整表快照，滚动时把整份快照写回，
   * 于是后开的那个会把先开的条目整条抹掉（或把它倒回旧值）。
   * 让它们指向同一个对象，谁写都是写同一份，问题从根上没了。
   */
  private reconcilePdf(): void {
    const { disk, fromRecords, live, stores } = this.pdfInputs();
    const merged = mergePdfHistory(disk, fromRecords, live);
    const key = serializePdfHistory(merged.files);
    const bound = stores.every(
      ({ store }) => store.database && store.database.files === this.pdfTable,
    );
    if (key === this.pdfTableKey && bound) return;

    const table = merged.files;
    this.pdfTable = table;
    for (const { fp, store } of stores) {
      const want = table.find((e) => e.fingerprint === fp);
      if (!want) continue;
      try {
        store.file = want;
        store.database = { files: table };
      } catch (e) {
        this.log("绑定 PDF 存储失败", e);
      }
    }
    if (key !== this.pdfTableKey) {
      this.writePdfHistoryRaw(key);
      this.pdfTableKey = key;
      this.log(`PDF 阅读位置表已对平：${table.length} 条`);
    }
  }

  /**
   * 打开 PDF 之前先把记录写回 pdf.js 的存储。
   * 这样它自己的恢复逻辑（连页内滚动位置一起还原）就能正常工作，
   * 不用我们去算滚动坐标。
   */
  private preparePdfFor(path: string): void {
    const rec = this.settings.view.records[path];
    if (!rec || rec.kind !== "pdf" || !rec.pdf || !isPdfEntryUsable(rec.pdf)) return;
    const disk = parsePdfHistory(this.readPdfHistoryRaw()).files;
    const merged = mergePdfHistory(disk, [{ ...rec.pdf }], []);
    const key = serializePdfHistory(merged.files);
    if (key === serializePdfHistory(disk)) return;
    this.writePdfHistoryRaw(key);
    this.pdfTableKey = key;
    this.pdfTable = merged.files; // 表换了，下一拍会重新绑到各视图上
    this.log(`打开前写回阅读位置：${path} → 第 ${rec.pdf.page} 页`);
  }

  private scheduleViewTick(delays: number[]): void {
    for (const d of delays) window.setTimeout(() => this.viewEngine.tick(), d);
  }

  // ══════════ 视窗侧：命令 ══════════════════════════════════

  async viewRemember(): Promise<void> {
    const n = this.viewEngine.rememberNow();
    await this.saveSettings();
    new Notice(n ? `已记住 ${n} 个视图的位置。` : "当前没有可记录的视图。");
  }

  async viewRestore(): Promise<void> {
    const n = this.viewEngine.restoreNow();
    await this.saveSettings();
    new Notice(n ? `已回到 ${n} 个视图的记录位置。` : "当前视图已经在记录的位置上了。");
  }

  async viewClear(): Promise<void> {
    this.settings.view.records = {};
    await this.saveSettings();
    new Notice("已清除这个 vault 的阅读位置记录。");
  }

  // ══════════ 杂项 ══════════════════════════════════════════

  /** 退出 / 关插件前的最后一拍 */
  private finishAll(): void {
    if (this.settings.fold.enabled && this.foldEngine) {
      const kept = this.foldEngine.flushOnUnload();
      if (kept) this.log(`退出前保存展开快照（${kept.length} 项）`);
    }
    if (this.settings.view.enabled && this.viewEngine) this.viewEngine.finish();
  }

  private flushFold(): void {
    if (this.foldFlushId !== null) window.clearTimeout(this.foldFlushId);
    this.foldFlushId = window.setTimeout(() => {
      this.foldFlushId = null;
      void this.saveSettings();
    }, 600);
  }

  /** 落盘防抖：滚动时每拍都可能有变化，但没必要每拍都写盘 */
  private flushView(): void {
    this.settings.view.records = pruneRecords(this.settings.view.records, MAX_RECORDS);
    if (this.viewFlushId !== null) window.clearTimeout(this.viewFlushId);
    this.viewFlushId = window.setTimeout(() => {
      this.viewFlushId = null;
      void this.saveSettings();
    }, 3000);
  }

  /**
   * 日志。开着「调试日志」时**同时写控制台与插件目录下的 view-memory-debug.log** ——
   * 这样出问题时不必让用户开 DevTools 抄控制台，直接读文件就能拿到真实决策链
   * （哪一拍跳过了、为什么跳过、套用后读回是多少）。
   */
  private log(...args: unknown[]): void {
    if (!this.settings || !this.settings.debug) return;
    const msg = args
      .map((a) =>
        typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a),
      )
      .join(" ");
    console.debug("[view-memory]", ...args);
    try {
      const adapter = this.app.vault.adapter as unknown as AdapterLike;
      const base = adapter?.basePath ?? adapter?.getBasePath?.();
      if (!base) return;
      const dir = this.manifest.dir || `${this.app.vault.configDir}/plugins/view-memory`;
      fs.appendFileSync(
        path.join(base, dir, "view-memory-debug.log"),
        `[${new Date().toISOString()}] ${msg}\n`,
        "utf8",
      );
    } catch {
      /* 写日志失败绝不能影响主流程 */
    }
  }

  /** 调试日志的落盘位置（设置页展示用） */
  logFilePath(): string {
    return `${this.manifest.dir || `${this.app.vault.configDir}/plugins/view-memory`}/view-memory-debug.log`;
  }

  // ══════════ 配置 ══════════════════════════════════════════

  async loadSettings(): Promise<void> {
    const raw: unknown = (await this.loadData()) ?? {};
    const merged = Object.assign(defaultSettings(), raw as Partial<MemorySettings>);

    // 折叠侧
    const f = merged.fold;
    if (!f || typeof f !== "object") merged.fold = defaultSettings().fold;
    if (!merged.fold.byVault || typeof merged.fold.byVault !== "object") merged.fold.byVault = {};
    for (const k of Object.keys(merged.fold.byVault)) {
      const v = merged.fold.byVault[k];
      merged.fold.byVault[k] = {
        expanded: normalizeExpanded(v && v.expanded),
        at: v && typeof v.at === "number" ? v.at : 0,
      };
    }

    // 视窗侧
    //
    // ★ 这里**不能**只靠上面那句浅合并。`Object.assign(defaultSettings(), raw)` 是用 raw.view
    //   **整个替换**掉默认 view 对象的 —— 于是「上次保存之后才新增的字段」就没有值。
    //   而 `x <= undefined` 恒为 false：restoreWindowMs 曾因此变成 undefined，
    //   「恢复窗口」判定永远不成立 → 恢复一次都没跑过（日志里连一条「套用」都没有）。
    //   所以这里逐字段重建，数值项一律兜底。
    const dv = defaultEngineSettings();
    const rv = (merged.view ?? {}) as unknown as Record<string, unknown>;
    const rk = (rv.kinds ?? {}) as Record<string, unknown>;
    const numOr = (x: unknown, fallback: number): number => {
      const n = num(x);
      return n !== null && n >= 0 ? n : fallback;
    };
    merged.view = {
      enabled: rv.enabled !== false,
      restore: rv.restore !== false,
      kinds: {
        pdf: rk.pdf !== false,
        md: rk.md !== false,
        canvas: rk.canvas === true,
        excalidraw: rk.excalidraw !== false,
      },
      settleMs: numOr(rv.settleMs, dv.settleMs),
      maxAttempts: Math.max(1, Math.round(numOr(rv.maxAttempts, dv.maxAttempts))),
      captureGraceMs: numOr(rv.captureGraceMs, dv.captureGraceMs),
      restoreWindowMs: numOr(rv.restoreWindowMs, dv.restoreWindowMs),
      records: normalizeRecords(rv.records),
    };

    // 原地更新，保持对象引用不变（两个引擎拿的就是这两个引用）
    if (!this.settings) this.settings = merged;
    else {
      Object.assign(this.settings.fold, merged.fold);
      Object.assign(this.settings.view, merged.view);
      this.settings.debug = merged.debug;
      this.settings.migrated = merged.migrated;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 从合并前的两个插件（fold-memory / view-memory）把各自的记录搬过来一次，
   * 免得合并这个动作本身让你丢掉已经攒下的展开状态与阅读位置。
   */
  async migrateLegacy(): Promise<{ fold: boolean; view: boolean }> {
    const done = { fold: false, view: false };
    if (this.settings.migrated) return done;
    try {
      const base = (this.app.vault.adapter as unknown as AdapterLike)?.basePath;
      if (typeof base !== "string" || !base) return done;

      const readJson = (id: string): Record<string, unknown> | null => {
        const p = path.join(base, this.app.vault.configDir, "plugins", id, "data.json");
        if (!fs.existsSync(p)) return null;
        try {
          const v: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
          return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      };

      const old = readJson("fold-memory");
      const oldByVault = old ? old.byVault : undefined;
      if (oldByVault && typeof oldByVault === "object" && Object.keys(oldByVault).length) {
        for (const [k, s] of Object.entries(oldByVault as Record<string, unknown>)) {
          if (this.settings.fold.byVault[k]) continue;
          const snap = (s ?? {}) as { expanded?: unknown; at?: unknown };
          this.settings.fold.byVault[k] = {
            expanded: normalizeExpanded(snap.expanded),
            at: typeof snap.at === "number" ? snap.at : 0,
          };
          done.fold = true;
        }
      }

      const oldView = readJson("view-memory");
      const oldRecords = oldView ? oldView.records : undefined;
      if (oldRecords && typeof oldRecords === "object" && Object.keys(oldRecords).length) {
        for (const [k, rec] of Object.entries(oldRecords as Record<string, unknown>)) {
          if (this.settings.view.records[k]) continue;
          const n = normalizeRecords({ [k]: rec });
          if (n[k]) {
            this.settings.view.records[k] = n[k];
            done.view = true;
          }
        }
      }

      this.settings.migrated = true;
      if (done.fold || done.view) {
        await this.saveSettings();
        this.log(`已从旧插件迁入记录：折叠 ${done.fold ? "有" : "无"}，视窗 ${done.view ? "有" : "无"}`);
      }
    } catch (e) {
      this.log("迁移旧插件记录失败（不影响使用）", e);
    }
    return done;
  }

  /** 设置页展示：折叠侧 */
  foldInfo(): {
    key: string;
    snapCount: number;
    snapAt: number;
    snapSummary: string;
    liveCount: number;
    blocked: number;
    armed: boolean;
  } {
    const key = this.vaultKey();
    const snap = this.settings.fold.byVault[key];
    return {
      key,
      snapCount: snap ? snap.expanded.length : 0,
      snapAt: snap ? snap.at : 0,
      snapSummary: snap ? snap.expanded.join("、") : "",
      liveCount: this.foldEngine ? this.foldEngine.readExpanded().length : 0,
      blocked: this.foldEngine ? this.foldEngine.blockedCount : 0,
      armed: this.foldEngine ? this.foldEngine.armed : false,
    };
  }

  /** 设置页展示：视窗侧 */
  viewInfo(): {
    stats: { restored: number; captured: number };
    recordCount: number;
    recent: { path: string; text: string; at: number }[];
    views: ViewReport[];
    pdfTableCount: number;
    timing: { settleMs: number; maxAttempts: number; restoreWindowMs: number };
  } {
    const recs = this.settings.view.records;
    const recent = Object.keys(recs)
      .map((p) => ({ path: p, at: recs[p].at, text: describeRecord(recs[p]) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 6);
    return {
      stats: this.viewEngine ? this.viewEngine.last : { restored: 0, captured: 0 },
      recordCount: Object.keys(recs).length,
      recent,
      views: this.viewEngine ? this.viewEngine.viewReport() : [],
      pdfTableCount: parsePdfHistory(this.readPdfHistoryRaw()).files.length,
      // 三个"该有值"的参数：它们曾经因为浅合并丢掉过 restoreWindowMs，
      // 而 undefined 参与比较恒为 false —— 于是恢复一次都没跑。列出来一眼可见。
      timing: {
        settleMs: this.settings.view.settleMs,
        maxAttempts: this.settings.view.maxAttempts,
        restoreWindowMs: this.settings.view.restoreWindowMs,
      },
    };
  }
}
