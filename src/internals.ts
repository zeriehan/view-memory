/**
 * Obsidian 未公开的内部结构。
 *
 * 这里只声明我们**真正用到**的那几项，字段名取自本机 1.13.7 的包。
 * 单独放一个文件，是为了让宿主适配层里 `as` 只出现在一处：宿主对象读进来先转到
 * 这些接口上，后面就是普通访问，不再满屏 `any`。
 *
 * 刻意不 import obsidian：用结构化的最小形状（`{ path?: string }` 这类）代替
 * `TFile`，这样纯函数层与引擎层也能引用它而不引入宿主依赖。
 */

import type { PdfEntry } from "./state";

/** 带路径的宿主对象（`TFile` / `TFolder` 的共同最小形状） */
export interface PathLike {
  path?: string;
}

/** 文件列表视图里的一条（`view.fileItems` 的值） */
export interface ExplorerItemLike {
  /** 宿主对象（主进程侧是 TFile）。引擎不碰它，只透传给 host.isFolder */
  file?: PathLike;
  collapsed?: boolean;
  setCollapsed?(collapsed: boolean, animate?: boolean): void | Promise<void>;
  toggleCollapsed?(animate?: boolean): void;
}

/** 文件列表视图内部那棵树，用它把折叠状态刷进宿主的存储 */
export interface ExplorerTreeLike {
  requestSaveFolds?(): void;
  saveFolds?(): void;
}

/** 文件列表视图 */
export interface ExplorerViewLike {
  fileItems?: Record<string, ExplorerItemLike>;
  tree?: ExplorerTreeLike;
}

/** Excalidraw 的 appState（只取视窗相关的几项） */
export interface ExcalidrawAppStateLike {
  scrollX?: unknown;
  scrollY?: unknown;
  zoom?: unknown;
  width?: unknown;
  height?: unknown;
}

/** Excalidraw 插件暴露的 API（只取我们用的三个方法） */
export interface ExcalidrawApiLike {
  getAppState?(): ExcalidrawAppStateLike | null;
  updateScene?(scene: {
    appState: { scrollX: number; scrollY: number; zoom: { value: number } };
  }): void;
  setViewport?(viewport: { scrollX: number; scrollY: number; zoom: number }): void;
}

/** 核心 Canvas 视图的状态 */
export interface CanvasViewStateLike {
  x?: unknown;
  y?: unknown;
  zoom?: unknown;
}

/** 核心 Canvas 视图 */
export interface CanvasLike {
  getState?(): CanvasViewStateLike | null;
  setState?(state: { x: number; y: number; zoom: number }): void;
}

/** pdf.js 的 ViewHistory（阅读位置就存在它里面） */
export interface PdfStoreLike {
  file?: PdfEntry;
  database?: { files: PdfEntry[] };
}

/** PDFViewerApplication 里我们用到的两项 */
export interface PdfViewerAppLike {
  store?: PdfStoreLike;
  pdfViewer?: { pagesCount?: number };
}

/** PDF 视图的包装层：view.viewer → .child → PDFViewerApplication */
export interface PdfViewHostLike {
  viewer?: { child?: { pdfViewer?: PdfViewerAppLike } };
}

/** 各种视图都有的那点公共形状 */
export interface LeafViewLike {
  file?: PathLike;
  canvas?: CanvasLike;
  setEphemeralState?(state: { subpath?: string }): void;
  getViewType?(): string;
  _loaded?: boolean;
  excalidrawAPI?: ExcalidrawApiLike;
  excalidrawData?: unknown;
  preventAutozoom?(): void;
  currentMode?: MarkdownSubViewLike;
}

/**
 * Markdown 的子视图（源码模式 / 预览模式都实现它）。
 *
 * 滚动位置用的**不是像素**：`getScroll()` 返回小数行号（本机 1.13.7 实现里是
 * `行号 + 行内偏移 / 行高`），`applyScroll()` 吃同一个口径。Obsidian 自己切模式时
 * 就是拿一边的 getScroll 直接喂给另一边，所以这个值天然跨模式可用，不必存模式。
 */
export interface MarkdownSubViewLike {
  getScroll?(): number;
  applyScroll?(scroll: number): void;
}

/** App 上的本地存储读取（Obsidian 没把它列进类型） */
export interface LocalStorageAppLike {
  loadLocalStorage?(key: string): unknown;
}

/** 文件适配器（桌面端才有 basePath） */
export interface AdapterLike {
  basePath?: string;
}
