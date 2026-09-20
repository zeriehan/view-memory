/**
 * 设置页。两个功能各占一节，互不干扰 —— 关掉哪边，那边的开关就整片隐藏，
 * 免得看着一堆用不上的选项。
 */
import { App, PluginSettingTab, Setting } from "obsidian";
import type ObsidianMemoryPlugin from "./main";

export class MemorySettingTab extends PluginSettingTab {
  plugin: ObsidianMemoryPlugin;

  constructor(app: App, plugin: ObsidianMemoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private infoBox(el: HTMLElement): {
    line: (label: string, value: string) => void;
    note: (text: string) => void;
  } {
    const box = el.createDiv();
    box.style.padding = "10px 14px";
    box.style.margin = "0 0 16px";
    box.style.borderRadius = "8px";
    box.style.background = "var(--background-secondary)";
    return {
      line: (label: string, value: string) => {
        const row = box.createDiv();
        row.createSpan({ text: label + "：", cls: "setting-item-description" });
        row.createSpan({ text: value });
      },
      note: (text: string) => box.createDiv({ text, cls: "setting-item-description" }),
    };
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "记忆助手" });
    containerEl.createEl("p", {
      text: "替 Obsidian 记住两类它自己记不住 / 会记错的东西：左侧文件列表展开到哪几层，以及每个 PDF 读到第几页、每个画布停在哪。",
    });

    this.renderFold(containerEl);
    this.renderView(containerEl);
    this.renderCommon(containerEl);
  }

  // ── 文件列表 ──────────────────────────────────────────────

  private renderFold(el: HTMLElement): void {
    el.createEl("h3", { text: "文件列表展开状态" });
    const s = this.plugin.settings.fold;

    new Setting(el)
      .setName("接管文件列表")
      .setDesc("记住展开到哪几层，重启后自动恢复；顺带挡掉 Obsidian 偶发的「一启动整棵树全收起」。")
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(async (v) => {
          s.enabled = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (!s.enabled) return;

    const info = this.plugin.foldInfo();
    const box = this.infoBox(el);
    box.line("当前 vault", info.key);
    box.line(
      "已记录",
      info.snapCount
        ? `${info.snapCount} 个展开文件夹${info.snapAt ? "（" + new Date(info.snapAt).toLocaleString() + "）" : ""}`
        : "还没有记录",
    );
    if (info.snapSummary) {
      box.note(
        info.snapSummary.length > 300 ? info.snapSummary.slice(0, 300) + "…" : info.snapSummary,
      );
    }
    box.line("当前界面实际展开", `${info.liveCount} 个`);
    box.line("已挡下可疑的整体折叠", `${info.blocked} 次`);

    new Setting(el)
      .setName("启动时恢复展开状态")
      .setDesc("关掉就只记录不恢复。")
      .addToggle((t) =>
        t.setValue(s.restoreOnStartup).onChange(async (v) => {
          s.restoreOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("完全还原")
      .setDesc(
        "开启后，快照里没有的文件夹会被主动收起，做到和上次一模一样。默认关闭 —— 关闭时只展开、不收起，更不容易误伤。",
      )
      .addToggle((t) =>
        t.setValue(s.exactRestore).onChange(async (v) => {
          s.exactRestore = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("挡掉可疑的整体折叠")
      .setDesc(
        "没有任何用户操作、却在启动后短时间内大面积收起时，判定为宿主的折叠丢失，改成恢复而不是记录下来。建议保持开启。",
      )
      .addToggle((t) =>
        t.setValue(s.ignoreMassCollapse).onChange(async (v) => {
          s.ignoreMassCollapse = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("立即恢复")
      .setDesc("按已记录的状态重排一次文件列表展开层级。")
      .addButton((b) =>
        b.setButtonText("恢复").onClick(async () => {
          await this.plugin.foldRestore();
          this.display();
        }),
      );

    new Setting(el)
      .setName("把当前状态记为基准")
      .setDesc("以你现在手动展开的样子为准，覆盖已有记录。")
      .addButton((b) =>
        b.setButtonText("记住当前").onClick(async () => {
          await this.plugin.foldRemember();
          this.display();
        }),
      );

    new Setting(el)
      .setName("清除记录")
      .setDesc("只清掉本插件的记录，不动 Obsidian 自己的存档。")
      .addButton((b) =>
        b.setButtonText("清除").onClick(async () => {
          await this.plugin.foldClear();
          this.display();
        }),
      );
  }

  // ── 阅读位置与视窗 ────────────────────────────────────────

  private renderView(el: HTMLElement): void {
    el.createEl("h3", { text: "阅读位置与视窗" });
    const s = this.plugin.settings.view;

    new Setting(el)
      .setName("接管阅读位置与视窗")
      .setDesc(
        "PDF 的位置存在 pdf.js 自己那张表里，插件同时会把那张表「对平」——多个 PDF 同时打开时它们会互相覆盖阅读位置，这才是那个毛病的根。",
      )
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(async (v) => {
          s.enabled = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (!s.enabled) return;

    const info = this.plugin.viewInfo();
    const box = this.infoBox(el);
    box.line("已记录", `${info.recordCount} 个文件的位置`);
    box.line("pdf.js 自己的表", `${info.pdfTableCount} 条`);
    box.line("上一次检查", `恢复了 ${info.stats.restored} 个、记录了 ${info.stats.captured} 个`);
    if (info.views.length) {
      box.note("当前打开的视图：");
      for (const v of info.views) {
        box.note(
          `· ${v.path}（${v.kind}${v.ready ? "" : "，还没加载完"}${v.managed ? "" : "，未接管"}）`,
        );
      }
    }
    if (info.recent.length) {
      box.note("最近记录：");
      for (const r of info.recent) box.note(`· ${r.path} → ${r.text}`);
    }

    new Setting(el)
      .setName("恢复阅读位置（总开关）")
      .setDesc("关掉就只记录、不恢复。")
      .addToggle((t) =>
        t.setValue(s.restore).onChange(async (v) => {
          s.restore = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("接管 PDF")
      .setDesc("PDF 页码/滚动位置的记录与恢复。")
      .addToggle((t) =>
        t.setValue(s.kinds.pdf).onChange(async (v) => {
          s.kinds.pdf = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("接管 Excalidraw 绘图")
      .setDesc(
        "Excalidraw 的 md 内嵌绘图不存视窗（数据里没有 scrollX/zoom），而且它的「打开时缩放以适应」默认开着，所以每次打开都会缩到全图。这里记住你上次停的地方并套回去。",
      )
      .addToggle((t) =>
        t.setValue(s.kinds.excalidraw).onChange(async (v) => {
          s.kinds.excalidraw = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("接管核心 Canvas")
      .setDesc(
        "默认关闭：核心 Canvas 本来就把视窗（x/y/zoom）写进 workspace.json，用不着我们管。如果发现它也丢，再打开。",
      )
      .addToggle((t) =>
        t.setValue(s.kinds.canvas).onChange(async (v) => {
          s.kinds.canvas = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("立即记录")
      .setDesc("把当前打开的视图位置存下来（不等轮询）。")
      .addButton((b) =>
        b.setButtonText("记住当前").onClick(async () => {
          await this.plugin.viewRemember();
          this.display();
        }),
      );

    new Setting(el)
      .setName("立即恢复")
      .setDesc("把当前打开的视图套回记录的位置。")
      .addButton((b) =>
        b.setButtonText("回到记录").onClick(async () => {
          await this.plugin.viewRestore();
          this.display();
        }),
      );

    new Setting(el)
      .setName("清除记录")
      .setDesc("只清本插件的记录，不动 pdf.js 自己那张表。")
      .addButton((b) =>
        b.setButtonText("清除").onClick(async () => {
          await this.plugin.viewClear();
          this.display();
        }),
      );
  }

  // ── 通用 ──────────────────────────────────────────────────

  private renderCommon(el: HTMLElement): void {
    el.createEl("h3", { text: "通用" });
    new Setting(el)
      .setName("调试日志")
      .setDesc("在开发者控制台输出对平、恢复与折叠对账的过程（Ctrl+Shift+I 打开）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
