"""生成桌面端的应用图标（v0.41）。

用法（需要后端那个 venv 的 Pillow）：::

    backend/.venv/Scripts/python.exe desktop/scripts/make-icons.py

## 为什么要有这个脚本，而不是"跑一次 tauri icon"

`tauri icon` 只做一件事：把**一张**源图缩成各个尺寸。而这颗标的问题恰恰在那个"缩"上：

1. **笔画太细，缩到小尺寸会糊成一团**。品牌标的外圆是 5.5/299、环是 2.2/299
   （见 `frontend/src/features/chat/ui/Logo.tsx` 与 `desktop/src/logo.svg`）——
   等比缩到 32px，外圆只剩 0.6px、环 0.24px，渲染出来是一片淡灰。
   网页那边早就解决了这件事：**给每根线一个"渲染像素下限"**（外圆与小圆 1.15px、
   环 0.8px），尺寸越小相对笔宽越粗，64px 以上自然回到原设计比例。
   这个脚本把同一条规则用在这里——**所以每个尺寸是分别画的，不是从一张图缩下来的**。
2. **之前那份图标还偏了**：512 那张里墨迹左边留白 104px、右边只有 30px
   （环的尖端伸到了 viewBox 之外，导出时没管），看着像往右歪。现在按**真实墨迹范围**
   居中，四边留白一致（`MARGIN_RATIO`）。
3. **托盘与任务栏会放大 32px 那张**：`tauri.conf.json` 的 `bundle.icon` 第一项是
   32x32.png，而 `App::default_window_icon()` 就是按这个列表取的——高 DPI 下
   （系统缩放 125%/150%）Windows 要 40/48px，于是把 32px 放大 → 糊。
   所以这里同时产出 128x128@2x.png（256）与一张**多帧 .ico**（16→256），
   并让配置里先列大图。

外观与之前一致：**白底 + 深色标**（只修正清晰度、居中与尺寸，不换设计）。
"""
from __future__ import annotations

import math
import pathlib
import sys

from PIL import Image, ImageDraw

ICON_DIR = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "icons"

#: 标的几何，单位与 `frontend/src/features/chat/ui/Logo.tsx`（mark 档）一致。
OUTER = {"cx": 182.5, "cy": 148.5, "r": 145.75, "w": 5.5}
RING = {"cx": 185.5, "cy": 155.5, "rx": 192.0, "ry": 44.0, "deg": -18.5, "w": 2.2}
MOON = {"cx": 318.5, "cy": 147.0, "r": 13.75, "w": 5.5}

#: 光学校正：每根线的**渲染像素下限**。
#:
#: 数值比 `frontend/src/features/chat/ui/Logo.tsx` 那套（1.15 / 0.8）**再粗一档**，因为场合不同：
#: 那边是界面里 22–34px 的标（旁边有文字、背景是页面），这里是 16–48px 的图标
#: （孤立地摆在任务栏/开始菜单上，用户扫一眼就要认出它）。
#: 实测（新旧并排看）：按 1.15/0.8 出来的 32px 比旧那版**细**——旧的是"粗+锯齿"
#: 显得实，所以这里取 1.6/1.15：小尺寸下够实在，又不至于像旧版 16px 那样糊成一团。
MIN_STROKE_PX = {"outer": 1.6, "ring": 1.15, "moon": 1.6}

#: 墨迹四周留白占画布的比例（现有那份约 7%~20% 且左右不均，这里取均匀的 12%）。
MARGIN_RATIO = 0.12

BG = (255, 255, 255, 255)
INK = (17, 17, 17, 255)

#: 逐尺寸渲染的候选（PNG）。.ico 的帧从这里面挑。
PNG_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)

#: 每个尺寸单独画的超采样倍数（画完再降采样，等于抗锯齿）。
SUPERSAMPLE = 8


def ink_box() -> tuple[float, float, float, float]:
    """三块图形的**真实**墨迹范围（含笔宽与环的旋转）。

    必须自己算：SVG 的 ``viewBox`` 是 0 0 370 299，而环在 x 方向伸到 377.5——
    照 viewBox 摆就会像旧那份一样偏右、右边几乎贴边。
    """
    left = min(OUTER["cx"] - OUTER["r"], MOON["cx"] - MOON["r"])
    right = max(OUTER["cx"] + OUTER["r"], MOON["cx"] + MOON["r"])
    top = min(OUTER["cy"] - OUTER["r"], MOON["cy"] - MOON["r"])
    bottom = max(OUTER["cy"] + OUTER["r"], MOON["cy"] + MOON["r"])
    for spec, key in ((OUTER, "outer"), (MOON, "moon")):
        left -= spec["w"] / 2
        right += spec["w"] / 2
        top -= spec["w"] / 2
        bottom += spec["w"] / 2

    angle = math.radians(RING["deg"])
    cos, sin = abs(math.cos(angle)), abs(math.sin(angle))
    ex = math.hypot(RING["rx"] * cos, RING["ry"] * sin)
    ey = math.hypot(RING["rx"] * sin, RING["ry"] * cos)
    pad = RING["w"] / 2
    left = min(left, RING["cx"] - ex - pad)
    right = max(right, RING["cx"] + ex + pad)
    top = min(top, RING["cy"] - ey - pad)
    bottom = max(bottom, RING["cy"] + ey + pad)
    return left, top, right, bottom


BOX = ink_box()


def render(size: int) -> Image.Image:
    """画一张 ``size × size`` 的图标（白底 + 深色标，线条按渲染像素下限加粗）。"""
    scale = size * SUPERSAMPLE
    left, top, right, bottom = BOX
    inner = scale * (1 - 2 * MARGIN_RATIO)
    # 按较大的一边适配：标是横宽形，等比装进方形画布后上下自然留白更多
    unit = inner / max(right - left, bottom - top)
    offset_x = (scale - (right - left) * unit) / 2 - left * unit
    offset_y = (scale - (bottom - top) * unit) / 2 - top * unit

    image = Image.new("RGBA", (scale, scale), BG)
    draw = ImageDraw.Draw(image)

    def stroke(name: str, design_w: float) -> float:
        """这一根线在**这一张**上该有多粗（见模块头第 1 条）。"""
        return max(design_w * unit, MIN_STROKE_PX[name] * SUPERSAMPLE)

    def circle(spec: dict, name: str) -> None:
        half = stroke(name, spec["w"]) / 2
        draw.ellipse(
            (
                offset_x + (spec["cx"] - spec["r"]) * unit - half,
                offset_y + (spec["cy"] - spec["r"]) * unit - half,
                offset_x + (spec["cx"] + spec["r"]) * unit + half,
                offset_y + (spec["cy"] + spec["r"]) * unit + half,
            ),
            outline=INK,
            width=round(stroke(name, spec["w"])),
        )

    circle(OUTER, "outer")

    # 环是旋转过的椭圆：画在单独一层上转完再贴（Pillow 的 ellipse 不能直接给角度）。
    width = math.ceil(stroke("ring", RING["w"]))
    layer = Image.new("RGBA", (scale, scale), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)
    cx = offset_x + RING["cx"] * unit
    cy = offset_y + RING["cy"] * unit
    layer_draw.ellipse(
        (
            cx - RING["rx"] * unit - width / 2,
            cy - RING["ry"] * unit - width / 2,
            cx + RING["rx"] * unit + width / 2,
            cy + RING["ry"] * unit + width / 2,
        ),
        outline=INK,
        width=width,
    )
    layer = layer.rotate(RING["deg"], resample=Image.BICUBIC, center=(cx, cy))
    image = Image.alpha_composite(image, layer)
    draw = ImageDraw.Draw(image)

    circle(MOON, "moon")
    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    rendered = {size: render(size) for size in PNG_SIZES}

    for size, image in rendered.items():
        target = ICON_DIR / ("icon.png" if size == 1024 else f"{size}x{size}.png")
        image.save(target)
        print(f"  {target.name:18s} {image.size[0]}x{image.size[1]}")

    # Tauri 的约定名：128x128@2x 就是 256（高 DPI 那一档）
    rendered[256].save(ICON_DIR / "128x128@2x.png")
    print("  128x128@2x.png     256x256")

    # 多帧 .ico：Windows 按 DPI 取最合适的一帧，不会把小的放大。
    # **显式要 BMP 帧**：Pillow 默认把每一帧都存成 PNG，而 ICO 里的 PNG 帧
    # 官方只保证 256×256 那一档（Vista 起），小尺寸用老式的 DIB 位图最稳妥——
    # 图标本来就是在修"显示不对"，不该在这里再赌一次兼容性。
    frames = [rendered[size] for size in ICO_SIZES]
    frames[-1].save(
        ICON_DIR / "icon.ico", sizes=[(s, s) for s in ICO_SIZES], bitmap_format="bmp"
    )
    print(f"  icon.ico           帧 {', '.join(str(s) for s in ICO_SIZES)}（BMP）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
