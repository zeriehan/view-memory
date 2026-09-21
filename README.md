# View Memory（view-memory）

> 需要 **Obsidian 1.13.0 或更高**：设置页用的是 1.13 起的声明式设置接口，这样这些设置项才会进 Obsidian 自己的设置搜索。

替 Obsidian 记住两类它自己记不住、或者会记错的东西：

| | 管什么 | 为什么需要这个插件 |
| --- | --- | --- |
| **文件列表** | 左侧文件树展开到哪几层 | Obsidian 存在 `localStorage` 里其实是存对了的，坏在**恢复**环节：社区插件多、启动慢时，一启动整棵树就被收起 |
| **阅读位置与视窗** | 每个 PDF 读到第几页、每个笔记滚到哪、每个 Excalidraw 画布停在哪（缩放/偏移） | PDF 的位置存在 pdf.js 自己那张表里，**多个 PDF 同时打开时会互相覆盖**；Markdown 的滚动位置 Obsidian 不保证恢复；Excalidraw 的视窗压根不往文件里存，且它的「打开时缩放以适应」默认开着 |

两件事本是同构的：都是「宿主把状态存在别处 / 存得不靠谱 → 我们自己按 vault 存一份并在合适时机套回去」。合并成一个插件后，轮询定时器、用户输入监听、设置页样板都只要一份。

> 由 `fold-memory` 与 `view-memory` 两个插件合并而来（2026-09-19）。第一次启用时会把这两个旧插件 `data.json` 里的记录搬过来一次。

---

## 一、文件列表展开状态（折叠）

### 真相
- 展开状态**不在 `workspace.json`**（文件列表视图只序列化 `sortOrder / autoReveal / showSearch / searchQuery`）。
- 它在 **`localStorage`**，键 `file-explorer-unfold`（宿主会自动加上 vault id 前缀），值是一个数组，内容是**当前展开着的**文件夹路径 —— 默认是折叠的，所以存的是"例外集合"。
- `saveFolds()` 节流 200ms，且 `if (!workspace.layoutReady) return`；`loadFolds()` 只在 `onLayoutReady` 里跑一次。

**写侧实测是正常的**（从 leveldb 里挖出过多条历史记录、路径全有效），所以问题在恢复。插件的策略是不等它：自己按 vault 存快照，启动后等 `fileItems` 真正建好再重新展开，之后每秒对账。顺手调宿主的 `requestSaveFolds()` 让它自己那份存储也刷新一遍。

### 三道防线（最关键的部分）
这类"替宿主补做"的插件，最大的风险不是没修好，而是**把好快照洗掉** —— 那比不修还糟：

1. **`armed` 之前一个字都不写盘。** 恢复完成前观察到的任何状态都不可信（此刻界面可能正处于"丢失"的样子）。
2. **`fileItems` 为空 = 状态未知 → 跳过。** 不能把"条目还没建好"当成"用户把整棵树收起来了"，否则真正的状态出现后反而永远修不回来。实现上 `currentSig()` 返回 `string | null`，`null` 表示未知。
3. **启动宽限期（5s）内任何缩水都判为"宿主丢了折叠" → 恢复而不是保存**；过宽限期后只拦"缩到 0"和"≥60% 且 ≥3 项"。用户刚点过/敲过（2s 内）则一律认。

---

## 二、阅读位置与视窗

### PDF：多开时互相覆盖
- 位置在 **`localStorage["pdfjs.history"]`**，按 **PDF 内容指纹**索引，形如
  `{files:[{fingerprint,page,zoom,scrollLeft,scrollTop,rotation,sidebarView,...}]}`。
- pdf.js 的 `ViewHistory` 构造时把**整张表**读成实例快照，之后**每滚动一次**就把**整份快照写回**（`setMultiple()` → `_writeToStorage()`，没有任何防抖），表还有 20 条上限。
- 于是每个 PDF 视图各握着一份自己的旧快照 —— 谁后写，谁把别人的条目整条抹掉或倒回旧值。你最后停在 pdf1，pdf1 赢；pdf2 就回到很久以前的记录。

**取证**：`.workbuddy/scripts/_pdf_history.cjs` 从 leveldb 把那张表挖出来，实测看到过同一张表 **6 条 → 1 条 → 6 条** 反复被覆盖。

**修法**四层：
1. 每秒把「磁盘上的表 + 我们按路径存的记录 + 打开视图的实况」合成一张（优先级 磁盘 < 记录 < 实况），并让**所有打开的 PDF 视图共用同一个 `database` 对象** —— 它们写的是同一份，互相覆盖从根上没了。
2. 监听 `file-open`，在 pdf.js 读表**之前**把该文件记录写回 localStorage → 它自己的恢复链路（连页内滚动位置一起）就正常工作了，不用我们去算滚动坐标。
3. 兜底 `setEphemeralState({ subpath: "#page=N" })` 深链跳页。
4. 另按**文件路径**存一份记录（免疫"内容指纹变化"和"20 条上限淘汰"）。

内部路径（从 `obsidian-1.13.7.asar` 读出来的）：
`leaf.view.viewer.child.pdfViewer` = `PDFViewerApplication` → `.store`（ViewHistory）/ `.pdfViewer`（pdf.js 的 PDFViewer）。

### Markdown：滚到哪
- 位置用 **`MarkdownView.currentMode.getScroll()`** 取，返回的**不是像素，而是小数行号**
  —— 本机 1.13.7 的实现是 `行号 + 行内偏移 / 行高`。回填用同口径的 `applyScroll()`。
- 这个口径**源码模式与预览模式通用**：Obsidian 自己切换模式时，就是拿一边的 `getScroll()`
  直接喂给另一边的 `applyScroll()`（见 asar 里的 `showEditor`），所以不必额外记"存的时候是哪个模式"。
- 存取时机：`file-open` 之后补几拍（250 / 600 / 1300 / 2600 ms）—— Markdown 没有"自己的存储"
  可以先写进去，只能等它渲染完再把位置摆回去。

### Excalidraw
md 内嵌的绘图数据里**没有** `scrollX / scrollY / zoom / appState`，而插件默认 `zoomToFitOnOpen = true` → 每次打开必然缩到全图。插件记住 `scrollX/scrollY/zoom`，回填时先 `preventAutozoom()`（1500ms 守卫）再 `updateScene`。

### 核心 Canvas
**默认不接管**：它的 `getState()` 返回 `{x,y,zoom}` 且被包进 leaf state，**本来就写进了 `workspace.json`**。如果发现它也丢，设置里把开关打开即可。

### 五道防线
1. 视图未就绪（`ready=false`）跳过。
2. **套用后 2.5s 静默期**：期内不回读、不重复套 —— 否则我们刚写的值立刻被当成"用户的新状态"读回来，把记录冲成中间态。
3. **★ 一个视图只摆一次**（这条是「PDF 来回闪」的根因）：下面任一命中就**永久交还**该视图（`handsOff`），此后只记录、绝不再套 ——
   - 套用之后**实况自己变了**（不是我们干的 = 用户在翻，或宿主异步落位）；
   - 已经和记录**到位**了；
   - 轮到该摆回去的那一拍，**用户正在翻**；
   - 试满 `maxAttempts` 还不成。

   少了这条，"摆回记录位置"会变成长期悬在头上的纠正：用户从第 15 页翻到 16 页，过一会儿被拽回 15，再跳回 16，来回闪。
4. **恢复阶段有时间上限**（`restoreWindowMs`，默认 6s，从视图第一次就绪算起）：过了就只记录、不再套用。
5. **用户一动手就停手**：`click/keydown/wheel/touchstart/scroll` 之后 800ms 内不套用。

---

## 设置项

- **接管文件列表**（关掉后该节其余选项隐藏）
  - 启动时恢复展开状态
  - 完全还原：快照里没有的文件夹也主动收起（默认关，只展开不收起，更不容易误伤）
  - 挡掉可疑的整体折叠（默认开）
- **接管阅读位置与视窗**（关掉后该节其余选项隐藏）
  - 恢复阅读位置（总开关）
  - 接管 PDF / 接管 Markdown 滚动位置（默认开）/ 接管 Excalidraw 绘图（默认开）/ 接管核心画布（默认关）
- **通用**：调试日志（控制台输出，Ctrl+Shift+I 查看）

两边各有「立即恢复 / 记住当前 / 清除记录」三个动作项（点整行即执行）。

## 命令面板

- 文件列表：恢复到上次的展开状态
- 文件列表：把当前展开状态记为基准
- 文件列表：清除这个 vault 的展开记录
- 阅读位置：把当前视图位置记为基准
- 阅读位置：回到记录的阅读位置 / 视窗
- 阅读位置：清除这个 vault 的位置记录

## 代码结构

```
src/folds.ts       折叠侧的纯函数（归一化 / 指纹 / judgeChange）
src/fold-engine.ts 折叠侧引擎（依赖全从 host 注入）
src/state.ts       视窗侧的纯函数（pdf 表合并 / 记录归一 / 视窗比对）
src/view-engine.ts 视窗侧引擎（依赖全从 host 注入）
src/main.ts        宿主适配：读实况 / 套回去 / 注册事件与命令
src/settings.ts    设置页
```

前四个文件**不 import obsidian**，所以能用 esbuild 打成 CJS 直接在 Node 里配假 host 跑完整链路。

## 测试

开发时用 Node 侧的桩测试回归（以忠实的最小 Obsidian 桩加载构建产物；套件随开发环境走，不随仓库发布）：

- 折叠侧回归：98 项
- 视窗侧回归：165 项
- 合并本身（命令 id 不撞车、配置分离、一个定时器驱动两边、记录迁移、设置页分节、启动引导、**Markdown 记录真能套回视图**）：37 项

## 依赖的非公开成员（升级 Obsidian 后需重跑回归）

- 文件列表：`view.fileItems`、`item.collapsed`、`item.setCollapsed(v, animate)`、`tree.requestSaveFolds()`
- **leaf 类型 ≠ 视图类型**：Markdown 的 leaf 类型是 `"markdown"`，不叫 `"md"`。`main.ts` 里 `LEAF_TYPE` 这张表就是干这个的，**凡按类型找叶子都要走它** —— 直接拿 `kind` 去 `getLeavesOfType()` 会查不到叶子，而查不到只会安静 `return null`，表现成「记录存了但永远套不回去」。
- PDF：`view.viewer.child.pdfViewer` → `.store` / `.pdfViewer`；`view.setEphemeralState()`
- Markdown：`view.currentMode.getScroll()` / `applyScroll(n)`（源码与预览都实现）
- Excalidraw：`view.excalidrawAPI`、`view.preventAutozoom()`、`view._loaded`、`view.excalidrawData`
- Canvas：`view.canvas.getState()` / `setState()`

都做了 try/catch 兜底，缺了就跳过对应的那半边。
