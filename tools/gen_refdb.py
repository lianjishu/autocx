#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""gen_refdb.py — 生成「紧凑参考字形库」，供油猴脚本在浏览器里做字体反混淆匹配。

背景
----
超星章节测验/作业页用 font-cxsecret 把密文字形画成真字（详见
docs/superpowers/specs/2026-11-19-quiz-font-deobfuscation.md §1.1）。
油猴脚本要在浏览器里把密文字渲染出来、和参考字形做 IoU 匹配，就必须带一份
「常用汉字的字形位图」。直接带 48×48 的 31354 字库太大，这里压成：

    N×N 二值位图（默认 24×24 = 72 B/字）
  + 码点存在位图（覆盖 U+4E00..U+9FA5，2613 B）
  → 6763 个 GB2312 汉字 ≈ 489 KB（base64 约 653 KB，gzip 后约 300 KB）

数据来源：`_font/refbits.json`（31354 个 48×48 位图，十进制大整数，bit i = 第 i 个像素，
行优先）。参考字体是思源黑体 SourceHanSansCN-Normal.ttf。

产物
----
  refdb-24.js     window.__CX_REFDB = { v, size, lo, hi, count, cpMask, bits }
                  （油猴脚本用 @require 引它，或把内容内联进脚本）
  refdb-24.bin    同样的数据，纯二进制（便于校验/二次加工）

自检
----
生成后会重读一遍 .bin、按位还原，和 48×48 下采样结果逐位比对，不一致就报错。

用法
----
  python gen_refdb.py --ref <refbits.json> --out-dir .            # 默认 24×24、GB2312 字符集
  python gen_refdb.py --ref ... --size 32 --charset all           # 32×32、CJK 全区间
"""
import argparse
import base64
import json
import os
import sys

import numpy as np

CJK_LO, CJK_HI = 0x4E00, 0x9FA5
SRC = 48           # refbits.json 里的位图边长
MASK_LEN = (CJK_HI - CJK_LO + 1 + 7) // 8   # 码点存在位图字节数 = 2613


def decode_mask(value: str) -> np.ndarray:
    """十进制大整数 -> 2304 位 0/1 数组（行优先，bit i = 像素 i）"""
    v = int(value)
    raw = v.to_bytes(SRC * SRC // 8, "little")
    return np.unpackbits(np.frombuffer(raw, dtype=np.uint8), bitorder="little")


def resample(bits48: np.ndarray, n: int) -> np.ndarray:
    """48×48 -> n×n 双线性 + 0.5 阈值（与浏览器端 resample 保持同一套算法）"""
    grid = bits48.reshape(SRC, SRC).astype(np.float32)
    s = SRC / n
    centers = (np.arange(n) + 0.5) * s - 0.5
    y0 = np.clip(np.floor(centers).astype(int), 0, SRC - 1)
    y1 = np.clip(y0 + 1, 0, SRC - 1)
    wy = np.clip(centers - y0, 0.0, 1.0)
    # 行方向
    rows = grid[y0, :] * (1 - wy)[:, None] + grid[y1, :] * wy[:, None]
    # 列方向
    x0 = y0
    x1 = y1
    wx = wy
    out = rows[:, x0] * (1 - wx)[None, :] + rows[:, x1] * wx[None, :]
    return (out >= 0.5).astype(np.uint8)


def gb_level(ch: str) -> int:
    """GB2312 分区：1=一级常用(16-55 区)，2=二级(56-87 区)，0=不在 GB2312"""
    try:
        b = ch.encode("gb2312")
    except UnicodeEncodeError:
        return 0
    if len(b) != 2:
        return 0
    zone = b[0] - 0xA0
    if 16 <= zone <= 55:
        return 1
    if 56 <= zone <= 87:
        return 2
    return 0


def render_bits(font, cp: int, n: int, px: int) -> np.ndarray | None:
    """用参考字体直接渲染（与 check_refdb / 浏览器端的查询渲染同一套流程）。

    这条路径比"从 refbits 的 48×48 二次降采样"更一致：查询端也是
    渲染→裁 bbox→缩放到 n→阈值，两边走同一套，IoU 更可信。
    """
    from PIL import Image, ImageDraw

    img = Image.new("L", (px, px), 0)
    ImageDraw.Draw(img).text((2, 2), chr(cp), font=font, fill=255)
    bbox = img.getbbox()
    if not bbox:
        return None
    img = img.crop(bbox).resize((n, n), Image.LANCZOS)
    p = img.load()
    return np.array([p[x, y] > 127 for y in range(n) for x in range(n)], dtype=np.uint8)


def pack_rows(bits: np.ndarray, n: int) -> bytes:
    """n×n 位图 -> 每行 ceil(n/8) 字节、高位在前的紧凑字节流"""
    per_row = (n + 7) // 8
    buf = bytearray()
    for y in range(n):
        row = bits[y * n:(y + 1) * n]
        for bx in range(per_row):
            b = 0
            for k in range(8):
                idx = bx * 8 + k
                if idx < n and row[idx]:
                    b |= 1 << (7 - k)
            buf.append(b)
    return bytes(buf)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="refbits.json 路径（--font 未给出时用它降采样）")
    ap.add_argument("--font", default=None,
                    help="参考字体 TTF/OTF；给出则直接渲染（与查询端同一套流程，IoU 更准）")
    ap.add_argument("--render-px", type=int, default=96, help="--font 模式下的渲染字号")
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--size", type=int, default=24, choices=[16, 20, 24, 32, 48])
    ap.add_argument("--charset", default="gb2312", choices=["gb2312", "l1", "all"],
                    help="gb2312=6763 常用字；l1=3755 一级常用字（内联用）；all=U+4E00..U+9FA5 全部")
    ap.add_argument("--name", default=None, help="输出文件名前缀，默认 refdb-<size>")
    a = ap.parse_args()

    print(f"[1/5] 读取 {a.ref}", file=sys.stderr)
    refs = json.load(open(a.ref, encoding="utf-8"))
    print(f"      参考字形 {len(refs)} 个", file=sys.stderr)

    font = None
    if a.font:
        from PIL import ImageFont
        font = ImageFont.truetype(a.font, a.render_px)
        print(f"      参考字体 {a.font} @ {a.render_px}px（直接渲染模式）", file=sys.stderr)

    def bits_of(cp: int):
        if font is not None:
            return render_bits(font, cp, a.size, a.render_px)
        return resample(decode_mask(refs[str(cp)]), a.size).reshape(-1)

    print(f"[2/5] 挑选字符集 charset={a.charset}", file=sys.stderr)
    cps = []
    for cp in range(CJK_LO, CJK_HI + 1):
        if font is None and str(cp) not in refs:
            continue
        if a.charset in ("gb2312", "l1"):
            lv = gb_level(chr(cp))
            if lv == 0 or (a.charset == "l1" and lv != 1):
                continue
        cps.append(cp)
    print(f"      候选 {len(cps)} 字", file=sys.stderr)
    if not cps:
        print("没有可用字符，检查 charsets/refbits 路径", file=sys.stderr)
        return 1

    print(f"[3/5] 生成 {a.size}×{a.size} 位图并打包", file=sys.stderr)
    per_row = (a.size + 7) // 8
    blob = bytearray()
    kept = []
    for i, cp in enumerate(cps):
        b = bits_of(cp)
        if b is None:
            continue
        blob += pack_rows(b, a.size)
        kept.append(cp)
        if (i + 1) % 1000 == 0:
            print(f"      ... {i + 1}/{len(cps)}", file=sys.stderr)
    cps = kept
    print(f"      有效 {len(cps)} 字", file=sys.stderr)

    mask = bytearray(MASK_LEN)
    for cp in cps:
        off = cp - CJK_LO
        mask[off >> 3] |= 1 << (7 - (off & 7))

    print("[4/5] 自检：重读打包结果并与生成结果逐位比对", file=sys.stderr)
    bad = 0
    stride = per_row * a.size
    check = list(range(0, min(200, len(cps)))) + list(range(max(0, len(cps) - 200), len(cps)))
    for j in check:
        cp = cps[j]
        exp = bits_of(cp)
        got = np.zeros(a.size * a.size, dtype=np.uint8)
        for y in range(a.size):
            for bx in range(per_row):
                b = blob[j * stride + y * per_row + bx]
                for k in range(8):
                    if bx * 8 + k < a.size and (b >> (7 - k)) & 1:
                        got[y * a.size + bx * 8 + k] = 1
        if not np.array_equal(exp, got):
            bad += 1
    if bad:
        print(f"      自检失败：{bad} 个不一致", file=sys.stderr)
        return 1
    print(f"      自检通过（{len(check)} 字逐位一致）", file=sys.stderr)

    name = a.name or f"refdb-{a.size}"
    os.makedirs(a.out_dir, exist_ok=True)
    bin_path = os.path.join(a.out_dir, name + ".bin")
    with open(bin_path, "wb") as f:
        f.write(bytes(mask))
        f.write(bytes(blob))

    meta = {
        "v": 1, "size": a.size, "lo": CJK_LO, "hi": CJK_HI,
        "count": len(cps), "perRow": per_row, "charset": a.charset,
        "cpMask": base64.b64encode(bytes(mask)).decode(),
        "bits": base64.b64encode(bytes(blob)).decode(),
    }
    js_path = os.path.join(a.out_dir, name + ".js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成，勿手改：gen_refdb.py */\n")
        f.write("window.__CX_REFDB=" + json.dumps(meta, separators=(",", ":")) + ";\n")

    raw_bits = len(blob)
    b64 = len(meta["bits"])
    print(f"[5/5] 写出：", file=sys.stderr)
    print(f"      {bin_path}  {os.path.getsize(bin_path) / 1024:.0f} KiB", file=sys.stderr)
    print(f"      {js_path}  {os.path.getsize(js_path) / 1024:.0f} KiB", file=sys.stderr)
    print(f"      字表位图 {MASK_LEN} B + 字形 {len(cps)}×{per_row * a.size} B = "
          f"{raw_bits / 1024:.0f} KiB，base64 {b64 / 1024:.0f} KiB", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())