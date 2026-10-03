# Kimi 设计 Token 对照表

本文是前端美术改造的**取值依据**，不是设计规范本身。规范见《前端设计规范》。

## 0. 来源与口径

- **取值来源**：`statics.moonshot.cn` 上 kimi.com 的线上 CSS（抓取 30 个样式表，解析 372 个自定义属性）。
- **主题口径**：Kimi 用 `:root`（浅色）与 `:root.dark`（深色）两套**同名不同值**的变量。本文所有值按块解析，不靠人工判断"哪个像深色"。
- **字号三档**：Kimi 另有 `:root[data-font-size=small]` 与 `[data-font-size=large]` 两组覆盖（各 48 个 token）。它的"字号设置"是**换一套值**，而 KYLAB 用的是 `--font-scale` 乘法——本轮保留乘法机制，并让乘法结果落在 Kimi 的三档上。
- **抓不到的**：间距密度、侧栏宽度、气泡形态这类观感无法从 CSS 反推，需要 Kimi 界面截图目视校准。

## 1. 底色与背景阶梯

| Kimi token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `Bg-GroundPC` | `#fbfaf9` | `#181817` | 页面底（暖白，不是纯白） |
| `Bg-Primary` | `#fff` | `#121212` | 抬起来的那一层（内容/卡片） |
| `Bg-Primary70` | `#ffffffb3` | `#121212b3` | 半透明版本，用于吸顶/浮层 |
| `Bg-Primary90` | `#ffffffe6` | `#121212e6` | 同上，更实 |
| `Bg-Secondary` | `#f5f5f5` | `#1f1f1f` | 次级填充（表头、条带） |
| `Bg-Tertiary` | `#fff` | `#292929` | 三级容器 |
| `Bg-Quaternary` | `#fff` | `#4d4d4d` | 四级容器 |

**分组背景（BgGp）**——`BgGp-*` 是"成组容器"的一套：浅色下组底是灰 `#f5f5f5`、组内卡片是白 `#fff`；深色下反过来，组底是 `#121212`、组内是 `#1f1f1f`。

| | 浅色 | 深色 |
| --- | --- | --- |
| `BgGp-Primary` | `#f5f5f5` | `#121212` |
| `BgGp-Secondary` | `#fff` | `#1f1f1f` |
| `BgGp-Tertiary` | `#f5f5f5` | `#292929` |

## 2. 文字标签（Labels）——关键在于它们都是**透明色**

Kimi 的文字色不是固定 hex，而是**压在地色上的 alpha 值**。底色换成暖白以后，文字会自然带上一点暖调——这是暖白观感的来源之一。

| Kimi token | 浅色 | 深色 | 合成后（浅） | 对比度（浅／深） |
| --- | --- | --- | --- | --- |
| `Labels-Primary` | `#000000e6` | `#ffffffd6` | `#191918` | **16.88:1** / 12.71:1 |
| `Labels-Secondary` | `#00000099` | `#ffffff8f` | `#646464` | 5.68:1 / 6.31:1 |
| `Labels-Tertiary` | `#00000073` | `#ffffff6b` | `#8a8989` | **3.35:1** / 4.08:1 |
| `Labels-Quaternary` | `#0000004d` | `#ffffff42` | `#afafae` | 2.11:1 / 2.34:1 |

**必须知道的事**：对照 KYLAB 现状（`--text-tertiary` 浅色 6.15:1、深色 6.09:1），Kimi 的 Tertiary 只有 **3.35:1**，Quaternary 只有 **2.11:1**——都低于 AA。这是刻意的取舍：Kimi 用"更浅的三四级灰"换取视觉上的安静，代价是小字可读性下降。

**本轮决定**：照抄 Kimi 的值，并同步修改《前端设计规范》里要求"三级灰必须过 4.5:1"的条款。为了不把可读性一刀切掉，另加一条**用途约束**（不改任何色值）：

- 正文、表单标签、表头、按钮文字一律用 `Labels-Primary/Secondary`；
- `Labels-Tertiary` 只用于**可略过的元信息**（计数器、时间戳、脚注）；
- `Labels-Quaternary` 只用于**禁用态与占位符**，不承载信息。

## 3. 填充与分隔

| Kimi token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `Fills-F1` | `#00000008` | `#ffffff0d` | hover 底 |
| `Fills-F2` | `#0000000d` | `#ffffff1a` | 次级 hover |
| `Fills-F3` | `#00000026` | `#ffffff2e` | 按下 / 选中底 |
| `Fills-F4` | `#00000040` | `#ffffff40` | 最重的填充 |
| `Separators-S1` | `#00000021` | `#ffffff1f` | **唯一的分割线口径** |

每个 Fill 与 Separator 都另有 `-hover` / `-active` 两档，实现时按需取用（如 `Fills-F1-hover` = `#0000000f`）。

**注意 `Separators-S1` 是 alpha**：`#00000021` 压在暖白上约等于 `#dcdbd9`，比 KYLAB 现在的 `--border-hairline: #ededec` **明显更深**。这是 Kimi 观感"更清楚"的原因之一。

## 4. 色彩（Colors）

| Kimi token | 浅色 | 深色 | 备注 |
| --- | --- | --- | --- |
| `Colors-KMBlue` | `#1783ff` | `#1a88ff` | 品牌蓝 |
| `Colors-Red` | `#ff3849` | `#ff4756` | |
| `Colors-PositiveGreen` | `#16c456` | `#16c456` | 两种主题同值 |
| `Colors-Yellow` | `#ffd230` | `#ffd230` | 同值 |
| `Colors-Orange` | `#ff9500` | `#ff9f0a` | |
| `Colors-Purple` | `#985ffb` | `#a16bff` | 第二强调色 |
| `Colors-Green` | `#32ff7d` | `#32ff7d` | 亮绿，非语义 |

浅色语义底：`Others-LightBlueBg #e8f3ff`、`Others-LightGreenBg #16c4561a`、`Others-LightYellowBg #ffc80033`、`Others-LightRedBg #ff4d4d1a`、`Others-LightOrangeBg #ff95001a`。
浅色蓝的浅底还有 `Others-KMBlue10 #1783ff1a`、选中态 `Others-TextSelected #1783ff33`。

### 品牌蓝当文字不合格——唯一一处刻意偏离

实测：`#1783ff` 在浅色底上 **3.52:1**、深色底上 4.85:1。Kimi 把品牌蓝**只当填充用**（按钮底、气泡底，上面压白字），所以它不需要为"蓝字"负责。KYLAB 有链接与彩色数字要当正文用，因此**新增一个 Kimi 没有的 token `--accent-text`**（加深档，保证 ≥4.5:1），并在规范里写明这是唯一的增补项及其理由。

## 5. 字号阶（ui-*）与三档

每个 token 都是 size + line-height 成对，并有一个 `_Emphasized` 孪生 token（同尺寸、更重的字重）。

| token | small | **默认** | large | 行高 small/默认/large |
| --- | --- | --- | --- | --- |
| `ui-T1` | 16 | **18** | 20 | 24 / 26 / 28 |
| `ui-T2` | 14 | **16** | 18 | 20 / 24 / 27 |
| `ui-B1` | 14 | **15** | 17 | 20 / 22 / 25 |
| `ui-B2` | 14 | **14** | 16 | 20 / 20 / 22 |
| `ui-C1` | 12 | **12** | 14 | 18 / 18 / 21 |
| `ui-C2` | 10 | **10** | 12 | 14 / 14 / 17 |

**两处与现状的冲突**：

1. **页标题从 28px 降到 18px**。Kimi 的 T1 只有 18px——它的层级不靠大标题，靠留白。KYLAB 现在的 `--text-page-title-size: 28px` 要改。
2. **`ui-C2` 是 10px**。KYLAB 现有规范明写"低于 12px 的中文不可读"，并把 micro 定在 13px。本轮把 C2 定义**照抄**，但加用途约束：**C2 只用于拉丁字母与数字的微标签**（版本号、计数徽标），中文最小仍用 C1（12px）。

## 6. 结构常量

| 项 | 值 |
| --- | --- |
| 聊天输入圆角 | `24px`（`--chat-input-radius`） |
| 聊天输入最大宽 | `768px` |
| 聊天输入高度 | `130px` |
| 顶栏高度 | `58px`（`--layout-header-height`） |
| 弹层圆角 | `20px`（`--km-modal-radius`） |
| 图标按钮 | 高 `36px`、圆角 `20px`、描边 **`0.5px`**、间距 `4px`、字号 `ui-B2`、字重 `400` |
| 图标不透明度 | 默认 `.56`、hover `.84`、禁用 `.26` |
| 弹层底（深色） | `#262630`，描边 `#31313a`（**带蓝调**，不是中性灰） |
| 动效 | `background-color .15s ease, color .15s ease, box-shadow .15s ease` |

**`0.5px` 描边**与**带蓝调的深色弹层**是两处容易漏掉的特征：前者让图标按钮在高分屏上几乎是"无线条的"，后者是 Kimi 深色界面的辨识度来源。

## 7. 字体

```
-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, Roboto, Noto Sans, Ubuntu,
Cantarell, Helvetica Neue, sans-serif, Arial, PingFang SC, Source Han Sans SC,
Microsoft YaHei UI, Microsoft YaHei
```
等宽：**Geist Mono**。

Kimi 不引入任何 webfont 做正文（纯系统字体栈，只为等宽指定了 Geist Mono），也不使用 Tailwind——样式全部是手写 CSS 加语义 token。KYLAB 现状（`system-ui` 起头 + `JetBrains Mono`）与它同构，本轮只调整顺序与等宽字体。

## 8. 映射表（KYLAB token ← Kimi token）

改造时按此表逐项替换，页面与组件不需要各自改色。

| KYLAB 现有 | 改为 Kimi | 说明 |
| --- | --- | --- |
| `--bg-canvas` | `--Bg-GroundPC` | 底色转暖 |
| `--bg-surface` | `--Bg-Primary` | |
| `--bg-subtle` | `--Bg-Secondary` | |
| `--bg-hover` | `--Fills-F1` | 改为 alpha 填充 |
| `--bg-active` | `--Fills-F3` | |
| `--bg-header` | `--Bg-Secondary` | |
| `--text-primary` | `--Labels-Primary` | 改为 alpha |
| `--text-secondary` | `--Labels-Secondary` | |
| `--text-tertiary` | `--Labels-Tertiary` | 对比度下降，见 §2 用途约束 |
| （新增） | `--Labels-Quaternary` | 禁用态与占位符 |
| `--border-hairline` | `--Separators-S1` | 变深 |
| `--border` | `--Separators-S1` | Kimi 只有一档 |
| `--border-strong` | `--Separators-S1-active` | |
| `--accent` | `--Colors-KMBlue` | 靛蓝 → 亮蓝 |
| （新增） | `--accent-text` | 唯一增补：蓝字加深档 |
| `--accent-soft` | `--Others-KMBlue10` | |
| `--accent-selected` | `--Others-TextSelected` | |
| `--accent-2` | `--Colors-Purple` | |
| `--status-success` | `--Colors-PositiveGreen` | |
| `--status-warning` | `--Colors-Orange` | |
| `--status-danger` | `--Colors-Red` | |
| `--status-info` | `--Colors-KMBlue` | |
| `--status-*-soft` | `--Others-Light*Bg` | |
| `--radius-control/row/panel/overlay` | `8 / 12 / 16 / 20` | 另加输入框 24 |
| `--text-*` 五档 | `--ui-T1/T2/B1/B2/C1` | 页标题 28→18 |
| `--heat-0..3` | 保留自定义 | Kimi 未暴露该族 |
