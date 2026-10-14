# 侧栏 rail chip 的溢出与长前缀呈现口径 · C-RAIL-2

> **口径一句话**：rail 里的长短码，**行内自伤可接受；跨行他伤不可接受**。
> 长短码允许在自己那一行里显得难看，但**不得**越出本行行盒、**不得**越出 rail 的 inline 盒（因而不产生 rail 内横向滚动）；**值仍逐字**（不截断），整串改由 `title` 承载。

> 卡：`T-20261014-061445`（goal：给出口径——legacy 长前缀在 rail 的呈现 / chip 溢出策略（U2 补正））。
> 来源：`T-20261014-053218` §② 的 U2 补正建议（承 `T-20261014-030233` C-RAIL-1 与 `T-20261014-011936-4`）。
> 分工：**本卡 = 设计口径 + 设计源（写面 `design/**`）+ 一次实测复核**（真 taskd + 真 SQLite + 真 `web/dist` + Chromium）；**零原型改动、零实现改动**。落点属实现，须另立实现卡（§7）。
> 事实源：原型 = `design/prototype/index.html`、`design/prototype/src/input.css`、`design/BLOCKS.md`、`design/DESIGN.md`（**实读**）；实现 = `web/src/components/shell/Sidebar.vue`、`web/src/styles/app.css`、`src/shared/ids.mjs`、`src/shared/wire.mjs`、`src/core/storage/repositories/projects.mjs`（**实读**）；几何与截图 = **实测**（本轮，宿主 Chromium，原始输出见 `evidence/chip-geometry.json`、`evidence/chip-threshold.json`）。
> 基线 commit：`41c5c03`（本 lane 的开工点 = `main`）。
> **本文件为新增文件**；未改动 `design/prototype/**` 一行（§8 A6）。

## 0. 结论摘要

- **① 缺陷复核：成立，且比原登记更广。** 36 字符 legacy 前缀在 24×24 chip 内换 4 行，绘制范围 **x −15.45..78.47**（rail 盒 0..64）、**y 299..372.5**（chip 盒 324..348）⇒ **同时压住上下相邻两行的 chip**（上：`Orchestrator Prod`；下：`MeerkatTaskPanel`），并在 rail 内造成 **19px 横向滚动**（980/760 同值；500 档 rail 56px ⇒ 23px）。1512 档 chip `display:none`，该观感不存在。文档级溢出横纵皆 0 ⇒ **门禁全盲**（§2.4）。
- **② 不是实现偏离：原型自身同病。** 把同一个 36 字符值注入原型（只改 DOM，不写文件）后，原型的 chip 同样换 4 行、同样压住上一行（`MeerkatTaskPanel`）、同样产生 rail 内 4px 横滚（§2.5）。⇒ 该断裂是**原型盒模型的属性**，实现只是把幅度放大——而放大的原因是 **13px vs 10px 的字号差**，一个 C-RAIL-1 §2.6 早已登记的既有差异。**因此任何修法都只改实现侧** ⇒ 属需 Elon 批准的单侧 UI/UX 变更（§6）。
- **③ 也不是 legacy 专属。** 阈值以**字符数**计：实现侧 hyphenated 前缀 **≥9 字符**即越出 rail 右缘、**≥10 字符**即越出本行行盒（§2.3）。CLI `--id` 路径（C-PREFIX-1 §8 E7）无长度上限；UI 的 `maxlength="4"`（E6）只是恰好挡住了 UI 入口。**「仅限 legacy 项目」这一表述只对「文档级布局未被破坏」成立，对 rail 内观感不成立。**
- **④ 任何截断都会毁掉可见唯一性——且 M4 举错了例子。** 24px 盒在出厂字号下**最多容纳 3 个字符**（3 字符 23.48px；4 字符 31.31px）。实测：容器化后 `Orchestra One` / `Orchestra Two` 同显 `HES`；加 `…`（含 `safe center`）后 `Orchestra One` / `Orchestra Two` / `Orchestrator Prod` **三者与真正的 `ORC` 项目同显 `ORC`**（§2.6）。M4 所举 `ORCHESTRATOR` vs `ORCHESTRA-2` 在 10 字符 cap 下**并不同形**（`ORCHESTRAT…` vs `ORCHESTRA-…`）；真正同形的是 **`ORCHESTRA-1` / `ORCHESTRA-2`** ⇒ M4 的**结论对、例子错**。
- **⑤ 裁定（§3）**：**不动 M4 的值条款，只补 M4 从未规定的盒条款**——长短码的**已绘制文本**必须留在本行行盒与 rail inline 盒之内；值仍逐字；盒几何不动；整串走 `title`（R8 的同一通道）。**不采用** clamp / `…` / R8 的字符 slice。
- **⑥ 代价如实登记（§3.3）**：该口径之下，超长 chip 会在**自己那一行**里显示一个**不带省略号的中段碎片**（`HES` / `-4A`）。本口径接受这一代价，因为两个替代方向的伤害更大：现状 = 一条长码毁掉**上下相邻两行**；截断 = **可见唯一性全失**（实测三行同形）。
- **⑦ 根治不在本卡（§6.2）**：两条路各有一处硬冲突（legacy 回退改不了——铸号时现读，改它会令存量项目新旧卡号前缀不一致，与 M5/M6 冲突；盒几何放宽——原型断言面，须同时动原型）。交 Elon。
- **⑧ 一处集成缺口（§4）**：C-RAIL-1 的**契约文件本身不在树里**（`design/contracts/side-rail-short-code.md` 仅存在于 `lane/T-20261014-011936-4-seg1`，从未并入 `main`），但它的实现与 5 个源文件的引用都在。本契约不依赖该文件的在树状态，必要条款在 §4 复述。

---

## 1. 口径与证据规则

**闭集词表（逐字使用，不得自创）**：`对齐` = 两侧**实测**同值；`一致` = 两侧书面/符号级同义（未实测）；`缺` = 原型有、实现无；`简化` = 实现存在但能力被削弱；`自创` = 原型无、实现新增；`口径` = 同意图的不同表达；`缺失口径` = 两端都没有、本轮首次定义。

**证据分级**：1 **实测**（本轮真跑：真 `createTaskd` + 真 SQLite + 真 `web/dist` + Chromium；真原型 `index.html` over `file://`）；2 **实读**（逐符号读过源码/原型/设计文档，未运行）；3 **实读未实测**（实现侧的运行行为若未跑即属此级）；4 **不伪造**（未跑的写「未跑」）。

**定位规则**：一律「**文件:选择器**」或「**文件:符号**」；**禁止行号锚**。

**本轮的实测面**：`docs/docker.md` §Host-allowed checks 明写 browser-rendered frontend checks 留在宿主机（镜像内无 Chromium），故本轮的几何与截图在宿主 Chromium 上取；**未进容器**（§8 E 段）。

## 2. 复核缺陷（Acceptance ①）

复跑方式、原始数据与截图见 §8。四个视口、同一次 `evaluate` + `screenshot` 配对（rail 是 `overflow:auto` 盒，中途采样会读到未落定的行位置）。

### 2.1 现状（实现，≤1023px rail）

| 视口 | rail clientW / scrollW | legacy chip 盒 | 绘制范围（`Range.getClientRects()` 合并） | 相交的行盒 |
|---|---|---|---|---|
| 980 | 63 / **82**（内滚 **19px**） | 24×24 @(19.5, 324) | x **−15.45..78.47**，y **299..372.5** | `Orchestrator Prod`（上）、`MeerkatTaskPanel`（下） |
| 760 | 63 / **82**（19px） | 24×24 @(19.5, 357) | x −15.45..78.47，y 332..405.5 | 同上 |
| 500 | 55 / **78**（**23px**） | 24×24 @(15.5, 355) | x −19.45..74.47，y 330..403.5 | 同上 |
| 1512 | 247 / 247（0） | **0×0**（`display:none`） | —（无 chip） | 无 |

- chip 盒是 24×24，而文本块 **4 行 ≈ 73.5px 高**（line-height 19.5px），以 flex `align-items:center` 居中 ⇒ **上下各溢出约 25px**。
- `docOverflow = {x:0, y:0}` 在四个视口全部成立 ⇒ dom-smoke 的视口规则看不见它。
- chip 的 computed：`display:flex`、`align-items:center`、`justify-content:center`、`overflow:visible`、`white-space:normal`、`width/height:24px`、`font-size:13px`、`line-height:19.5px`（`web/src/styles/app.css` 的 `≤1023px` 块）。
- 截图：`evidence/chip-v0_baseline-980.png`（肉眼可见：legacy 的四行文本横穿并**盖住 `TD` chip 的文字**）。

### 2.2 与上一轮登记（`T-20261014-053218`）的异同

| 上一轮登记 | 本轮复核 |
|---|---|
| 36 字符；4 行盒；最宽 93.92px | ✅ 一致（93.92px） |
| 裁剪盒 = `aside.td-sidebar`（`overflow:auto`），不是 `[data-project-list]` | ✅ 一致 |
| 纵向**未**被裁、第 1 行落进上一行行盒并**盖住其短码** | ✅ 成立，且**更强**：本轮测到它同时压住**下一行**（上下相邻两行都中）；上一轮只记了上一行 |
| rail 内 15px 横向滚动 | 数值不同（本轮 19px / 500 档 23px）——**因为种子不同**：滚动量取**最宽那一行**，上一轮的板里最宽行与本轮不同。**结论不变**（rail 内确有横向滚动）。 |
| 「后果仅限 legacy 项目」 | ⚠️ **需限定**：对**文档级布局**成立（doc overflow 恒 0）；对**rail 内观感不成立**——见 §2.3，任何 **≥9 字符**的前缀都已越出 rail 右缘。 |

### 2.3 阈值扫描（`evidence/chip-threshold.json`；把 chip 的文本换成 N 字符后读几何）

实现侧（13px mono、chip 24×24、rail 64px / clientW 63）：

```text
hyphenated（`A1B2C3D4-E5F6-…` 逐步截断）
  ≤8  字符 → 1 行，行宽 23.48 → 62.63px，留在行盒内、留在 rail 内
  ≥9  字符 → 越出 rail 右缘（9 字符行宽 70.45px > rail 64px）
  ≥10 字符 → 换行为 2 行，且文本块**越出本行行盒**（此后每 +6 字符多一行，36 字符 = 4 行）
solid（`AAAA…`，无断点）
  任意长度 → **永不换行**；36 字符 = **一行 281.77px**；≥9 字符即越出 rail 右缘
```

原型侧（10px mono、`letter-spacing:-0.1px`、line-height 15px、chip 24×24）：

```text
hyphenated: 换行从 10 起，越出本行行盒从 19 起，越出 rail 右缘从 35 起
solid:      永不换行；36 字符 = 213.14px；越出 rail 右缘从 11 起
```

⇒ **两侧同一类断裂，阈值不同仅因字号不同**（10px/15px vs 13px/19.5px）。该字号差是 C-RAIL-1 §2.6 表里**已登记**的既有差异（契约把字体/颜色/边框划归 `ui-align` 的 computed 腿，本契约不重开）。

### 2.4 门禁盲区（实测）

- `web/manifests/board.json` / `board-m2.json`：**没有任何** rail chip 盒规则（`grep 'side-icon'` 只命中一条 prose `evidence` 串）⇒ `ui-align` 对 chip 几何无断言。
- `test/web/blocks.contract.mjs` 对 chip 只有一条 `count … equals: 0`（`[data-nav]` 内不得带该钩子），**无** overflow/几何断言。
- `test/web/side-rail-short-code.test.mjs` 钉的是「值来自 wire、不派生、钩子形态」（A1/A2/A3/A7），**不钉盒**。
- `docOverflow` 恒 0（§2.1）⇒ dom-smoke 的视口规则不响。

⇒ **该缺陷对现有全部门禁不可见**；实现卡必须自带浏览器腿（§7 D1/D2），不得依赖既有门禁。

### 2.5 原型（oracle）在同一输入下的行为——**实测**

原型 `design/prototype/index.html` 的 rail 只有三个静态种子（前缀 `ORC`/`TD`/`SR`，均 ≤3 字符）⇒ **无样本**。本轮把 36 字符值**注入 DOM**（`chip.textContent = …`，**未写文件**；原型以 `file://` 加载）后：

| 视口 | rail clientW / scrollW | 绘制范围 | 相交的行盒 |
|---|---|---|---|
| 980 | 63 / **67**（内滚 **4px**） | x **−4.02..67.03**，y **290..346** | `MeerkatTaskPanel`（上一行） |
| 760 | 63 / 67（4px） | x −4.02..67.03，y 323..379 | 同上 |

⇒ **原型自身也溢出、也压住相邻行的 chip、也在 rail 内产生横向滚动。** 差别只在幅度（原型 4px / 实现 19px），而幅度差由已登记的字号差解释（§2.3）。

**这一点是本契约的定性支点**：该断裂**不是实现相对原型的偏离**，而是原型盒模型在原型样本之外的自然后果 ⇒ 定性为**原型遗漏（omission）**，同时**任何修法都是单侧实现改动**（§5 U1）。

### 2.6 候选口径的实测（把候选 CSS 注入页面，不改树）

| 候选 | rail 内横滚 | 越出本行 | **盒内可见字符**（`Orchestra One` / `Orchestra Two` / `Orchestrator Prod` / legacy） | 截图 |
|---|---|---|---|---|
| **v0 现状** | 19px | **是**（压住上下两行） | `HEST` / `HEST` / `ESTRA` / `-4A7-`（**且盒外的字符也画出来**，横穿邻行） | `chip-v0_baseline-980.png` |
| **v1 容器化**（`overflow:hidden`） | **0** | 否 | `HEST` / `HEST` / `ESTRA` / `-4A7-`——**与 v0 的盒内字符逐字相同**，差别是盒外的**不再绘制** | `chip-v1_contain-980.png` |
| **v2 单行 + `…`**（`overflow:hidden;white-space:nowrap;text-overflow:ellipsis`） | 0 | 否 | 头对齐失败（居中裁剪）：可见 `HEST`-类中段，**省略号落在盒外、不绘制** | `chip-v2_nowrap_ellipsis-980.png` |
| **v2s v2 + `justify-content:safe center`** | 0 | 否 | `ORC` / `ORC` / `ORC` / `A1B`——前三者**与真 `ORC` 项目的 chip 逐字相同** | `chip-v2s_nowrap_safe_center-980.png` |
| **v3 v2s + R8 的 10 字符 slice + `title`** | 0 | 否 | `ORC` / `ORC` / `ORC` / `A1B`——**与 v2s 逐字相同**（盒先于 slice 裁） | `chip-v3_r8_slice-980.png` |
| **v4 盒自适应**（`width:auto;max-width:100%`） | 0 | **仍是**（块高 138.5px，压住四行） | 换行成 7 行，**更糟** | `chip-v4_grow_box-980.png` |
| **v5 v4 + 行高自适应** | 0 | 否（行被撑高） | 不压邻行，但**rail 节奏被破坏**（行距 34px → 45.5..56px 不等，rail 需纵向滚动） | `chip-v5_grow_box_row-980.png` |

**盒内可见字符是逐字符测出来的**（每个字符一个 `Range` 矩形，与 chip 盒相交者计为可见；`evidence/chip-visible-text.json`），不是从截图读的——这正是「中段碎片」的准确形态：11 字符的 `ORCHESTRA-1` 在 24px 盒里读到的是第 4..7 个字符 `HEST`，而从截图**看不出**起点在第几个，因为盒外也在画。

**三条实测结论**：

1. **24px 盒最多容纳 3 个字符**（3 字符 = 23.48px；4 字符 = 31.31px 已越出盒）。因此**任何**截断都必然把 `ORCHESTRA-1`/`ORCHESTRA-2`/`ORCHESTRATOR-PROD` 与 `ORC` 缩成同一个可见串。
2. **R8 的 10 字符 slice 对 chip 无效**：v3 与 v2s 的**可见字符逐字相同**（`ORC`/`ORC`/`ORC`/`A1B`）——盒（3 字符）先于 slice（10 字符）裁，多出来的 7 个字符从不进入 24px 盒。把 identifier 的显示口径搬到 chip 上，不产生它在大面积渲染点上的效果。
3. **M4 所举的例子错了，但结论对**：10 字符 cap 下 `ORCHESTRATOR`(12) → `ORCHESTRAT…` 与 `ORCHESTRA-2`(11) → `ORCHESTRA-…` **不同形**；真正同形的是 `ORCHESTRA-1` / `ORCHESTRA-2`（**实测**，见 `checks/seed-board.txt` 的 `cappedAt10`：两者都是 `ORCHESTRA-…`）。

## 3. 裁定（Acceptance ②）

### 3.1 主口径（U2-P）

> **rail 中的长短码：行内自伤可接受；跨行他伤不可接受。**

五条行为条款（**只谈盒与可达性，不改 M4 的值条款**）：

- **P1｜不自伤他行。** chip 的**已绘制文本**必须留在**本行行盒**之内——不得因换行而上溢/下溢压到相邻行（现状在 980/760/500 三档全部违反，且同时压住上下两行）。
- **P2｜不出 rail。** 已绘制文本必须留在 rail 的 **inline 盒**之内——不得越出 rail 右缘，因而不产生 rail 内横向滚动（现状 19px / 500 档 23px）。
- **P3｜值逐字。** DOM 里的文本节点仍是**有效前缀原文**；**不** slice、**不** `…`、**不**首字母压缩、**不**客户端推导、**不**大小写变换。即 M4 的**值条款不动**（C-RAIL-1 §3.1 M4；本轮无法在树内引用该文件，条款在此复述）。
- **P4｜盒几何不动。** chip 仍 24×24；≤1023px 可见、名字隐藏；≥1024px `display:none`（`design/BLOCKS.md` §B03「prefix monogram, rail only」）。1512 档现状即**无 chip**，本口径不引入新面。
- **P5｜整串可达。** chip 增 `title` = **完整有效前缀**。这是 R8/`DESIGN.md` §24.3 对 identifier 用的**同一通道**（「full id stays on `title`；the visible text is a *display value*」）。属**声明式最小补充**——原型不动，按 U1a 先例（C-RAIL-1 §7 U1，Elon 择 (a)）登记。
  - **如实限定**：chip 是 `aria-hidden="true"` 的装饰元素，故 `title` 只给**指针悬停**的整值通道，**不给**辅助技术通道。≤1023px 下 chip 是唯一的**已绘制**身份线索；这一层应由实现卡一并取证（行 `<button>` 的可访问名是否含项目名），本契约不预设结论。

**P2 的机制留给实现卡**（几何不变、值不变，实现有自由）。可用的原语至少两种：在 chip 上建立**包含**（clipping，如 `overflow` 非 `visible`），或把 chip 的**内容**收进一个受约束的盒。本契约只钉**可观测行为**（§7 D1/D2），不钉声明。

### 3.2 与既有设计源的关系（为什么这不是「重开 M4」）

| 源 | 它规定了什么 | 与本口径的关系 |
|---|---|---|
| C-RAIL-1 §3.1 **M4**（值） | 短码**逐字**、不截断 | **不动**（P3）。M4 谈的是**值**；它**从未**规定 chip 的 `overflow`，也从未要求溢出示人。 |
| 原型的 chip CSS | `display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px`（`design/prototype/src/input.css`；**实测 computed `display` = `flex`** —— 它是行 flex 的子项，`inline-flex` 被块化，实现侧同） | **只规定盒，未规定溢出。** 两处都**没有**写 `overflow` ⇒ 溢出是**没写**，不是**要求**（omission）。故 P1/P2 不与原型冲突。 |
| `DESIGN.md` §24.3（R8） | 超长 identifier 的显示 = 前 10 字符 + `…`；整值走 `title`；**slice 是机制、width 只是单行护栏** | **部分同向**：P5 采用它的 `title` 通道。**部分不采用**：§24.3 的 slice **对 chip 无效**（§2.6 实测 v3≡v2s）。 |
| `DESIGN.md` §28.3（R12 rejected） | ①「让 identifier **换行到第二行**」被**否决**（「an id is one unbroken token; wrapping splits an indivisible string」）；②「做成**可横向滚动的盒**」被否决（「'fully visible' would become 'fully reachable'」） | **同向，且构成本口径的旁证**：现状的 rail chip 恰好同时做了这两件被否决的事（换 4 行 + rail 内横滚）。该节讲的是抽屉头，本契约不据此宣称「矛盾」，只登记**方向一致**。 |
| `BLOCKS.md` §B03 | `.td-side-icon`（prefix monogram, **rail only**） | **同向**：一个 4 行外溢的文本块不是 monogram。B03 未给长度上界 ⇒ 本契约补的正是这条**缺失口径**。 |
| C-PREFIX-1 M3/M5/M6 | 有效前缀的推导、唯一、创建后不可变 | **不动**；§6.2 说明为什么「给前缀长度上界」这条路走不通。 |

### 3.3 代价（如实登记，不藏）

P1+P2 之下，**超长**（≥10 字符）的短码在**它自己那一行**里会显示一个**不带省略号的中段碎片**（**逐字符实测** v1：`HEST` / `HEST` / `ESTRA` / `-4A7-`）。读者无法从 chip 判断该串是不是完整前缀的一部分，也无法从 chip 区分 `Orchestra One` 与 `Orchestra Two`——**两者读到的是同一个 `HEST`**。

**注意这一碎片不是本口径引入的**：v0（现状）在同一个 24px 盒里读到的是**同样的**字符（§2.6 表）；本口径改变的只是**盒外那些字符是否还画到别行去**。也就是说 P1/P2 **不制造**碎片，它只**停止扩散**。

**本口径接受这一代价**，因为另外两个方向的伤害都更大：

- **现状（v0）**：一条长码的文本**同时盖住上下相邻两行**的 chip ⇒ 伤害**波及与它无关的行**，而 rail 是 ≤1023px 下**唯一的身份线索**。这是三者中唯一**跨行**的伤害。
- **截断（v2/v2s/v3 任一）**：可见唯一性**全部丧失**——实测三行与真正的 `ORC` 项目同形，且 `…` 在 24px 盒里根本**不绘制**（省略号落在盒外）。

⇒ 排序：**跨行他伤（必须消除）> 行内不可读（接受）> 可见唯一性全失（不采用）**。

## 4. 与 C-RAIL-1 的关系（一处集成缺口，如实登记）

C-RAIL-1（`design/contracts/side-rail-short-code.md`，commit `31904db`）**从未并入 `main`**：`git merge-base --is-ancestor 31904db HEAD` = 假，`git cat-file -e HEAD:design/contracts/side-rail-short-code.md` = 不存在；但它的**实现**（wire 的 `prefix`、`Sidebar.vue` 读 `project.prefix`、`monogram.js` 已删、`test/web/side-rail-short-code.test.mjs`、`web/scripts/dom-smoke.mjs` 的 R6）与 **5 个源文件对 `C-RAIL-1` 的引用**（`src/shared/wire.mjs`、`web/src/components/shell/Sidebar.vue`、`test/web/side-rail-short-code.test.mjs`、`test/cli/output.test.mjs`、`web/scripts/dom-smoke.mjs`）**都在树里**。

⇒ 本契约**不依赖**该文件的在树状态：§3.1 P3 直接复述 M4 的值条款。**待办（交 Elon，非本卡）**：把 C-RAIL-1 的契约文件补并回 `main`，否则「M4/M5」在树内是**无出处的条款名**。

**边界（防止下游把两张卡做成一件事）**：

| 问题 | 归谁 |
|---|---|
| 短码的**值**是什么、从哪来、是否唯一 | C-RAIL-1 M1–M5（**本契约不改**） |
| 短码在**盒装不下**时怎么呈现、盒的边界在哪 | **本契约（C-RAIL-2）** |
| 上面两件事的**代码**改动 | 各另立实现卡；本契约的落点见 §7 |

## 5. 未决 / 交 Elon

**U1 · 本口径的落点属「单侧 UI/UX 变更」。** 原型自身同病（§2.5），任何修法都**只改实现侧**；而本仓 SOP 要求单侧 UI/UX 变更由 Elon/operator 双签。⇒ **请 Elon 批准 P1/P2 的实现**（或择 §6.2 的另一条路）。未获批准前，实现卡不得开工。

**U2 · `title` 这一补充是否可接受为「最小补充」。** 判据与 U1a（建项目行补短码、原型不动、登记在册）同形；本契约按该先例登记，**请 Elon 确认**。

**U3 · 是否把「有效前缀的长度上界」单列一张产品卡。** 见 §6.2（i）——它是**唯一**能让 rail 真正读出身份的方向，但改的是 C-PREFIX-1 M3 的回退面，**不属于**本卡的写面。

**U4 · C-RAIL-1 契约文件的补并**（§4）。

## 6. 根治方向（均不在本卡权限内，仅登记）

### 6.1 已排除：靠「改字号」缩小观感

原型 10px / 实现 13px 的差是 C-RAIL-1 §2.6 登记的**既有**差异，且字号属 `ui-align` 的 computed 腿；把它拉回 10px 只把阈值从 10 推到 19（§2.3），**不消除**断裂。⇒ 不作为口径。

### 6.2 两条根治路，各有一处硬冲突

**(i) 给「有效前缀」长度上界（改 C-PREFIX-1 M3 的 legacy 回退）。** ❌ **实测不可行**：`src/core/storage/repositories/projects.mjs:allocateIdentifier` 在**铸号事务里**现读 `projectPrefix({id, meta})`（`src/shared/ids.mjs:projectPrefix`）——回退一旦改变，存量 legacy 项目的**新卡**会拿到与**旧卡**不同的前缀，而 M5/M6 要求「一个项目一个前缀、创建后不可变」。⇒ 该方向要动的是**编号**，收益远小于代价。

**(ii) 放宽 rail 内 chip 的盒几何（R4 的 24×24）。** ⚠️ **须同时动原型**（R4 的盒几何是原型断言面），与卡面「零原型改动」冲突；且即使把 chip 放到 rail 的内容宽（56px ≈ 7 字符），仍不足以区分 `ORCHESTRA-1` / `ORCHESTRA-2`（前 7 字符相同）。⇒ 收益有限、代价是原型变更。

⇒ 本卡**两条都不自选**，只把实测依据交给 Elon。

## 7. 交给实现卡的口径（Acceptance ③：本卡零代码）

本卡**只出设计口径**。以下断言清单是给**另立的实现卡**的；该卡按 flow A 另配独立验证腿。

**必须成立（D 腿，浏览器；宿主允许）**

| # | 断言 | 现状 |
|---|---|---|
| **D1** | 任意前缀长度下，chip 的**已绘制文本**（`Range.getClientRects()` 与 chip 盒的交集）**不与本行以外的任何行盒相交** | **红**（980/760/500 三档均压住上下两行） |
| **D2** | 已绘制文本不越出 rail 的 inline 盒；`aside.scrollWidth − aside.clientWidth === 0` | **红**（19px / 19px / 23px） |
| **D3** | `chip.textContent === wire.prefix` 逐字；文本不含 `…`；无 slice/派生（沿用 C-RAIL-1 §8 A1/A3 的静态腿） | 绿（保持） |
| **D4** | `chip.title === wire.prefix` | **缺**（chip 现无 `title`） |
| **D5** | ≤3 字符前缀的绘制与现状**逐字相同**（chip 内仍居中、24×24）——即对出厂种子无回归 | 绿（保持） |
| **D6** | 1512 档 chip 仍 `display:none`（B03 不回归） | 绿（保持） |
| **D7** | `docOverflow` 仍为 `{x:0,y:0}`（不得以扩大页面溢出换取 rail 内不溢出） | 绿（保持） |

**必须注意**

1. **既有门禁对这条口径全盲**（§2.4）：`ui-align` 无 chip 盒规则、`docOverflow` 恒 0、`blocks.contract.mjs` 只钉一条 `count … equals: 0` ⇒ **D1/D2 必须由实现卡自带浏览器腿**，不得以「门禁全绿」代替。
2. **`test/web/side-rail-short-code.test.mjs` 的 A7 会因 P5 而红**：它逐字断言 `<span class="td-mono" data-side-icon aria-hidden="true">`，加 `title` 后该字面串不再匹配 ⇒ 实现卡须**同一步**重钉 A7（这是本契约预期的红，不是回归）。
3. **不得**引用 `…` / slice / clamp 作为实现手段（§3.1 P6 与 §2.6 实测）。
4. 测量口径（沿用上一轮的坑）：用 `Range.getClientRects()` 读**文本块**（元素自身 `getBoundingClientRect()` 恒报 24px）；**量与该状态下的截图必须同一次运行同刻**（rail 是 `overflow:auto`，中途采样会读到未落定的行位置）；探针要同时读两类钩子（原型用类名 `.td-side-icon`、实现用 `data-side-icon`）。

## 8. 证据与复跑

**原始数据**

| 文件 | 内容 |
|---|---|
| `evidence/chip-geometry.json` | 4 视口 × 7 候选 × 全行几何（盒、行盒、绘制矩形、相交、rail client/scroll）+ 原型的同输入实测 + wire 投影 |
| `evidence/chip-threshold.json` | 阈值扫描（实现 / 原型；hyphenated 与 solid 两种形态，2..40 字符） |
| `evidence/chip-visible-text.json` | **逐字符**的盒内可见性（每个字符一个 `Range` 矩形 ∩ chip 盒）——§2.6 / §3.3 的「可见字符」即出自此，非截图读取 |
| `checks/chip-probe.txt` / `checks/chip-threshold.txt` / `checks/chip-visible-text.txt` | 上述三次运行的 stdout 原文 |
| `checks/full-suite-clean.txt` | 判定性全量 `node --test`：`exit 0`，`pass 2257 / fail 0 / skipped 1`。**注意**：全量跑**不要**设 `TASKD_DB` —— `resolveDbPath` 会忽略每个测试自己的 `dataDir` 而所有测试共用一个库，与 `coverage-gate` 的内嵌 `node --test` 撞 `UNIQUE constraint failed: projects.id`（详见报告 §7） |
| `checks/seed-board.txt` | 种子板（真 use-case 建 7 个项目，含 legacy UUID 与 `ORCHESTRA-1`/`ORCHESTRA-2` 对）的 wire 投影原文 |

**截图**（3× device pixel ratio，rail 区域裁剪；每张与同一状态的几何读数同刻）

| 文件 | 内容 |
|---|---|
| `evidence/chip-v0_baseline-{980,760,500}.png` | 现状：长码横穿并盖住相邻行的 chip |
| `evidence/chip-v1_contain-*.png` … `chip-v5_grow_box_row-*.png` | §2.6 的六个候选，逐档同刻 |
| `evidence/prototype-chip-long-{980,760}.png` | 原型在同一输入下的溢出（**只改 DOM，未写文件**） |

**复跑（3 步，全部在宿主机）**

```bash
TREE=<本 lane worktree>
WS=~/.openclaw/team/workspace/T-20261014-061445
npm --prefix "$TREE/web" ci --prefer-offline --no-audit --no-fund   # 宿主 npm cache（committed cache 是 linux/arm64）
npm --prefix "$TREE/web" run build                                  # 产出 web/dist
node "$WS/tools/seed-board.mjs"     "$WS/run/board.sqlite" "$WS/run/data" "$TREE"
node "$WS/tools/rail-chip-probe.mjs"   "$TREE"  # 4 视口 × 7 候选 + 原型腿
node "$WS/tools/chip-threshold.mjs"    "$TREE"  # 阈值扫描
node "$WS/tools/chip-visible-text.mjs" "$TREE"  # 逐字符的盒内可见性
```

**A 腿（纯静态/纯函数，宿主机允许）**

| # | 断言 | 结果 |
|---|---|---|
| A6 | `git diff --stat -- design/prototype` 为空 | 空（本轮与基线 `41c5c03` 比） |
| A7 | 本卡的仓写面 = `design/**` 三处（本文件 + `design/README.md` + `design/BLOCKS.md` §B03 指针） | 见报告 |

**E 段 · 未跑（明写，不圆）**

- **未进容器**（`npm run verify:docker`）：本卡零实现改动、零原型改动；容器腿对 `design/**` 盲（`.dockerignore` 丢弃 `design/`），跑它不会为本卡增加信息。已在**完整 checkout** 上跑 `node --test` 与 `scripts/verify/*`（结果见报告）。
- **未在其他引擎取样**：全部几何取自宿主 Chromium。
- **未核查存量库里 id 形态的分布**：36 字符是 **UUID 形 id 的上界样本**，不是分布。

## 9. 附：术语

| 词 | 本契约的含义 |
|---|---|
| **chip** | `[data-project-list] [data-project] [data-side-icon]`（实现）/ `.td-side-icon`（原型）；≤1023px 的 rail 内项目短码 |
| **rail** | ≤1023px 的折叠侧栏（`aside[data-sidebar]`，`overflow:auto`；宽 64px，≤560px 档 56px） |
| **有效前缀** | C-PREFIX-1 M3：项目的存储前缀（非空）否则 `identifierPrefix(项目 id)`；实现为 `src/shared/ids.mjs:projectPrefix` |
| **已绘制文本** | chip 内文本行盒（`Range.getClientRects()`）与其自身盒的交集——**不是**元素盒（元素盒恒 24×24，报不出溢出） |
| **跨行他伤** | 一条 chip 的已绘制文本落进**别行**的行盒（会盖住别行的 chip） |
