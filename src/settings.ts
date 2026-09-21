/**
 * 设置页。
 *
 * 用 Obsidian 1.13 起的**声明式**设置接口（`getSettingDefinitions`）：这样这些
 * 设置项会进 Obsidian 自己的设置搜索。该接口只在 1.13+ 存在，所以 manifest 的
 * `minAppVersion` 相应提到 1.13.0（命令式的 `display()` 已弃用，不再维护两套）。
 *
 * 取值：声明式接口靠 `getControlValue` / `setControlValue`（key → 我们自己的配置）。
 * 两边各自关掉时，后面的项干脆不产出，所以不需要 `visible` 谓词。
 */
import { App, PluginSettingTab, SettingDefinition, SettingDefinitionItem } from "obsidian";
import type ObsidianMemoryPlugin from "./main";

export class MemorySettingTab extends PluginSettingTab {
  plugin: ObsidianMemoryPlugin;

  constructor(app: App, plugin: ObsidianMemoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── 控件取值 ──────────────────────────────────────────────

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    switch (key) {
      case "fold.enabled":
        return s.fold.enabled;
      case "fold.restoreOnStartup":
        return s.fold.restoreOnStartup;
      case "fold.exactRestore":
        return s.fold.exactRestore;
      case "fold.ignoreMassCollapse":
        return s.fold.ignoreMassCollapse;
      case "view.enabled":
        return s.view.enabled;
      case "view.restore":
        return s.view.restore;
      case "view.kinds.pdf":
        return s.view.kinds.pdf;
      case "view.kinds.canvas":
        return s.view.kinds.canvas;
      case "view.kinds.excalidraw":
        return s.view.kinds.excalidraw;
      case "debug":
        return s.debug;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    const on = value === true;
    switch (key) {
      case "fold.enabled":
        s.fold.enabled = on;
        break;
      case "fold.restoreOnStartup":
        s.fold.restoreOnStartup = on;
        break;
      case "fold.exactRestore":
        s.fold.exactRestore = on;
        break;
      case "fold.ignoreMassCollapse":
        s.fold.ignoreMassCollapse = on;
        break;
      case "view.enabled":
        s.view.enabled = on;
        break;
      case "view.restore":
        s.view.restore = on;
        break;
      case "view.kinds.pdf":
        s.view.kinds.pdf = on;
        break;
      case "view.kinds.canvas":
        s.view.kinds.canvas = on;
        break;
      case "view.kinds.excalidraw":
        s.view.kinds.excalidraw = on;
        break;
      case "debug":
        s.debug = on;
        break;
      default:
        return;
    }
    await this.plugin.saveSettings();
    // 两个总开关决定后面还出不出项（结构变了）→ 重新出定义；其余只刷一下状态
    if (key === "fold.enabled" || key === "view.enabled") this.update();
    else this.refreshDomState();
  }

  // ── 定义 ──────────────────────────────────────────────────

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: "group", heading: "文件列表展开状态", items: this.foldItems() },
      { type: "group", heading: "阅读位置与视窗", items: this.viewItems() },
      { type: "group", heading: "通用", items: this.commonItems() },
    ];
  }

  private foldItems(): SettingDefinition[] {
    const items: SettingDefinition[] = [
      {
        name: "接管文件列表",
        desc: "记住展开到哪几层，重启后自动恢复；顺带挡掉 Obsidian 偶发的「一启动整棵树全收起」。",
        control: { type: "toggle", key: "fold.enabled" },
      },
    ];
    if (!this.plugin.settings.fold.enabled) return items;

    items.push({ name: "当前状态", desc: this.foldInfoFragment() });
    items.push(
      {
        name: "启动时恢复展开状态",
        desc: "关掉就只记录、不恢复。",
        control: { type: "toggle", key: "fold.restoreOnStartup" },
      },
      {
        name: "完全还原",
        desc: "开启后，快照里没有的文件夹会被主动收起，做到和上次一模一样。默认关闭 —— 关闭时只展开、不收起，更不容易误伤。",
        control: { type: "toggle", key: "fold.exactRestore" },
      },
      {
        name: "挡掉可疑的整体折叠",
        desc: "没有任何用户操作、却在启动后短时间内大面积收起时，判定为宿主的折叠丢失，改成恢复而不是记录下来。建议保持开启。",
        control: { type: "toggle", key: "fold.ignoreMassCollapse" },
      },
      {
        name: "立即恢复",
        desc: "按已记录的状态重排一次文件列表展开层级。",
        action: () => void this.run(() => this.plugin.foldRestore()),
      },
      {
        name: "把当前状态记为基准",
        desc: "以你现在手动展开的样子为准，覆盖已有记录。",
        action: () => void this.run(() => this.plugin.foldRemember()),
      },
      {
        name: "清除记录",
        desc: "只清掉本插件的记录，不动 Obsidian 自己的存档。",
        action: () => void this.run(() => this.plugin.foldClear()),
      },
    );
    return items;
  }

  private viewItems(): SettingDefinition[] {
    const items: SettingDefinition[] = [
      {
        name: "接管阅读位置与视窗",
        desc: "PDF 的位置存在 pdf.js 自己那张表里，插件同时会把那张表「对平」—— 多个 PDF 同时打开时它们会互相覆盖阅读位置，这才是那个毛病的根。",
        control: { type: "toggle", key: "view.enabled" },
      },
    ];
    if (!this.plugin.settings.view.enabled) return items;

    items.push({ name: "当前状态", desc: this.viewInfoFragment() });
    items.push(
      {
        name: "恢复阅读位置（总开关）",
        desc: "关掉就只记录、不恢复。",
        control: { type: "toggle", key: "view.restore" },
      },
      {
        name: "接管 PDF",
        desc: "PDF 页码与滚动位置的记录与恢复。",
        control: { type: "toggle", key: "view.kinds.pdf" },
      },
      {
        name: "接管 Excalidraw 绘图",
        desc: "Excalidraw 的 md 内嵌绘图不存视窗（数据里没有滚动位置与缩放），而且它的「打开时缩放以适应」默认开着，所以每次打开都会缩到全图。这里记住你上次停的地方并套回去。",
        control: { type: "toggle", key: "view.kinds.excalidraw" },
      },
      {
        name: "接管核心画布",
        desc: "默认关闭：核心画布本来就把视窗（偏移与缩放）写进 workspace.json，用不着我们管。如果发现它也丢，再打开。",
        control: { type: "toggle", key: "view.kinds.canvas" },
      },
      {
        name: "立即记录",
        desc: "把当前打开的视图位置存下来（不等轮询）。",
        action: () => void this.run(() => this.plugin.viewRemember()),
      },
      {
        name: "立即恢复",
        desc: "把当前打开的视图套回记录的位置。",
        action: () => void this.run(() => this.plugin.viewRestore()),
      },
      {
        name: "清除记录",
        desc: "只清本插件的记录，不动 pdf.js 自己那张表。",
        action: () => void this.run(() => this.plugin.viewClear()),
      },
    );
    return items;
  }

  private commonItems(): SettingDefinition[] {
    return [
      {
        name: "调试日志",
        desc: "在开发者控制台输出对平、恢复与折叠对账的过程（Ctrl+Shift+I 打开）。",
        control: { type: "toggle", key: "debug" },
      },
    ];
  }

  // ── 小工具 ────────────────────────────────────────────────

  /** 跑一个动作，跑完把「当前状态」那块重新算一遍 */
  private async run(fn: () => Promise<void>): Promise<void> {
    await fn();
    this.update();
  }

  /** 一行「标签：值」 */
  private infoLine(box: HTMLElement | DocumentFragment) {
    return (label: string, value: string) => {
      const row = box.createDiv({ cls: "view-memory-info-row" });
      row.createSpan({ text: label + "：", cls: "setting-item-description" });
      row.createSpan({ text: value });
    };
  }

  /** 折叠侧的当前状态（声明式接口里 desc 支持 DocumentFragment） */
  private foldInfoFragment(): DocumentFragment {
    const info = this.plugin.foldInfo();
    return createFragment((frag) => {
      const box = frag.createDiv({ cls: "view-memory-info-box" });
      const line = this.infoLine(box);
      line("当前 vault", info.key);
      line(
        "已记录",
        info.snapCount
          ? `${info.snapCount} 个展开文件夹${
              info.snapAt ? "（" + new Date(info.snapAt).toLocaleString() + "）" : ""
            }`
          : "还没有记录",
      );
      if (info.snapSummary) {
        box.createDiv({
          text:
            info.snapSummary.length > 300 ? info.snapSummary.slice(0, 300) + "…" : info.snapSummary,
          cls: "setting-item-description",
        });
      }
      line("当前界面实际展开", `${info.liveCount} 个`);
      line("已挡下可疑的整体折叠", `${info.blocked} 次`);
    });
  }

  /** 视窗侧的当前状态 */
  private viewInfoFragment(): DocumentFragment {
    const info = this.plugin.viewInfo();
    return createFragment((frag) => {
      const box = frag.createDiv({ cls: "view-memory-info-box" });
      const line = this.infoLine(box);
      line("已记录", `${info.recordCount} 个文件的位置`);
      line("pdf.js 自己的表", `${info.pdfTableCount} 条`);
      line("上一次检查", `恢复了 ${info.stats.restored} 个、记录了 ${info.stats.captured} 个`);
      for (const v of info.views) {
        box.createDiv({
          text: `· ${v.path}（${v.kind}${v.ready ? "" : "，还没加载完"}${
            v.managed ? "" : "，未接管"
          }）`,
          cls: "setting-item-description",
        });
      }
      if (info.recent.length) {
        box.createDiv({ text: "最近记录：", cls: "setting-item-description" });
        for (const r of info.recent) {
          box.createDiv({ text: `· ${r.path} → ${r.text}`, cls: "setting-item-description" });
        }
      }
    });
  }
}
