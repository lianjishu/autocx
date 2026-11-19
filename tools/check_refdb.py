#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""check_refdb.py — 用紧凑参考库解码真实密文字体，并与已知映射比对。

用途：gen_refdb.py 产出的 refdb-*.bin 是给油猴脚本用的；这个脚本是它的"体检"：
拿一份真实的 font-cxsecret 字体，把 cmap 里的每个密文字形渲染出来，用 refdb
做 IoU 匹配，再和已知正确的 map（cx_font.py build-map 的产物）逐条对照。

用法
----
  python check_refdb.py --refdb refdb-24.bin --ttf artefont.ttf --expect artefont_map.json
  # 不给 --expect 时只打印解码结果，用于肉眼判断
"""
import argparse
import json
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

RENDER_PX = 64
MASK_LEN = (0x9FA5 - 0x4E00 + 1 + 7) // 8


def load_refdb(path):
    """返回 (cps[list[int]], bits bool[N, n*n], n)"""
    data = open(path, "rb").read()
    mask = np.frombuffer(data[:MASK_LEN], dtype=np.uint8)
    bits_mask = np.unpackbits(mask, bitorder="big")
    cps = [0x4E00 + i for i, v in enumerate(bits_mask) if v]
    body = data[MASK_LEN:]
    n = int(round((len(body) // len(cps)) ** 0.5 * 1))  # 先粗估
    # stride 必须是 ceil(n/8)*n；用总长反解出合法 n
    for cand in (16, 20, 24, 32, 48):
        stride = ((cand + 7) // 8) * cand
        if stride * len(cps) == len(body):
            n = cand
            break
    else:
        raise ValueError(f"refdb 尺寸不合法：len(body)={len(body)}, count={len(cps)}")
    stride = ((n + 7) // 8) * n
    rows = np.frombuffer(body, dtype=np.uint8).reshape(len(cps), stride)
    per_row = (n + 7) // 8
    out = np.zeros((len(cps), n * n), dtype=np.uint8)
    for y in range(n):
        chunk = rows[:, y * per_row:(y + 1) * per_row]          # (N, per_row)
        unpacked = np.unpackbits(chunk, axis=1, bitorder="big")  # (N, per_row*8)
        out[:, y * n:(y + 1) * n] = unpacked[:, :n]
    return cps, out.astype(bool), n


def read_cmap(path):
    d = open(path, "rb").read()
    u16 = lambda o: struct.unpack(">H", d[o:o + 2])[0]
    u32 = lambda o: struct.unpack(">I", d[o:o + 4])[0]
    n = u16(4)
    off = None
    for i in range(n):
        r = 12 + i * 16
        if d[r:r + 4] == b"cmap":
            off = u32(r + 8)
    if off is None:
        raise ValueError("no cmap")
    best = None
    for i in range(u16(off + 2)):
        r = off + 4 + i * 8
        pid, eid, so = u16(r), u16(r + 2), u32(r + 4)
        if pid == 3 and eid == 10:
            best = off + so
            break
        if pid == 3 and eid == 1 and best is None:
            best = off + so
    fmt = u16(best)
    mp = {}
    if fmt == 4:
        seg = u16(best + 6) // 2
        end_o = best + 14
        start_o = end_o + seg * 2 + 2
        delta_o = start_o + seg * 2
        range_o = delta_o + seg * 2
        for s in range(seg):
            e, st = u16(end_o + s * 2), u16(start_o + s * 2)
            dl = struct.unpack(">h", d[delta_o + s * 2:delta_o + s * 2 + 2])[0]
            ro = u16(range_o + s * 2)
            if st == 0xFFFF:
                continue
            for cp in range(st, e + 1):
                if ro == 0:
                    g = (cp + dl) & 0xFFFF
                else:
                    gi = range_o + s * 2 + ro + (cp - st) * 2
                    if gi + 2 > len(d):
                        continue
                    g = u16(gi)
                    if g:
                        g = (g + dl) & 0xFFFF
                if g:
                    mp[cp] = g
    elif fmt == 12:
        for g in range(u32(best + 12)):
            o = best + 16 + g * 12
            sc, ec, sg = u32(o), u32(o + 4), u32(o + 8)
            for cp in range(sc, ec + 1):
                mp[cp] = sg + (cp - sc)
    else:
        raise ValueError(f"unsupported cmap fmt {fmt}")
    return mp


def glyph_bits(font, cp, n):
    img = Image.new("L", (RENDER_PX, RENDER_PX), 0)
    ImageDraw.Draw(img).text((2, 2), chr(cp), font=font, fill=255)
    bbox = img.getbbox()
    if not bbox:
        return None
    img = img.crop(bbox).resize((n, n), Image.LANCZOS)
    px = img.load()
    return np.array([px[x, y] > 127 for y in range(n) for x in range(n)], dtype=np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refdb", required=True)
    ap.add_argument("--ttf", required=True)
    ap.add_argument("--expect", default=None)
    ap.add_argument("--min-score", type=float, default=0.75)
    ap.add_argument("--min-margin", type=float, default=0.04)
    a = ap.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    cps, ref, n = load_refdb(a.refdb)
    print(f"refdb: {len(cps)} 字 @ {n}×{n}，{len(cps) * n * n / 8 / 1024:.0f} KiB")

    cmap = read_cmap(a.ttf)
    print(f"ttf : cmap 覆盖 {len(cmap)} 个密文码点")

    font = ImageFont.truetype(a.ttf, RENDER_PX)
    got = {}
    low = []
    t_hits = 0
    for cp in sorted(cmap):
        b = glyph_bits(font, cp, n)
        if b is None:
            continue
        inter = (ref & b).sum(axis=1)
        union = (ref | b).sum(axis=1)
        iou = np.where(union > 0, inter / np.maximum(union, 1), 0.0)
        order = np.argsort(-iou)
        best, second = int(order[0]), int(order[1])
        s, s2 = float(iou[best]), float(iou[second])
        got[cp] = cps[best]
        if s < a.min_score or (s - s2) < a.min_margin:
            low.append((cp, cps[best], s, s - s2))
        t_hits += 1

    print(f"解码 {t_hits} 个字，低置信 {len(low)} 个")
    for cp, t, s, m in low[:10]:
        print(f"  低置信 {chr(cp)} -> {chr(t)}  IoU {s:.3f}  margin {m:.3f}")

    if a.expect:
        exp = {int(k): v for k, v in json.load(open(a.expect, encoding="utf-8")).items()}
        keys = set(exp) | set(got)
        same = sum(1 for k in keys if exp.get(k) == got.get(k))
        rate = same / len(keys) if keys else 0
        print(f"与已知映射比对：{len(keys)} 条，一致 {same} 条 → {rate * 100:.1f}%")
        for k in [k for k in keys if exp.get(k) != got.get(k)][:8]:
            print(f"  差异 {chr(k)}: 期望 {chr(exp[k]) if k in exp else '缺失'}"
                  f"，实得 {chr(got[k]) if k in got else '缺失'}")
        return 0 if rate >= 0.99 else 1

    print("解码结果（按码点序）：")
    print("  " + " ".join(f"{chr(k)}->{chr(v)}" for k, v in got.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())