#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""inject_refdb.py — 把紧凑参考字形库 gzip 后内联进油猴脚本。

为什么内联：脚本要"断网也能解码"。外链（@require）失败会连累整个脚本，
运行时 fetch 又要联网——所以默认把一级常用字（3755 字）压成 gzip+base64 塞进脚本，
想要全量 6763 字的人再把 font.refdb_url 指向发布的 refdb-24.js。

用法：
  python inject_refdb.py --bin test/fontdec/refdb-l1-24.bin
  python inject_refdb.py --bin ... --script 学习通助手.user.js --dry-run
"""
import argparse
import base64
import gzip
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BEGIN = "  // >>> AUTOCX-REFDB-INLINE"
END = "  // <<< AUTOCX-REFDB-INLINE"
PATTERN = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.S)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True, help="gen_refdb.py 产出的 .bin")
    ap.add_argument("--script", default=os.path.join(ROOT, "学习通助手.user.js"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    raw = open(a.bin, "rb").read()
    gz = gzip.compress(raw, 9, mtime=0)          # mtime=0 让产物可复现
    b64 = base64.b64encode(gz).decode()

    src = open(a.script, encoding="utf-8").read()
    if not PATTERN.search(src):
        print("脚本里找不到 AUTOCX-REFDB-INLINE 标记", file=sys.stderr)
        return 1
    payload = (
        f"  const REFDB_GZ = '{b64}';"
        f" // 内联位图库：{len(raw)} B -> gzip {len(gz)} B -> base64 {len(b64)} B"
    )
    out = PATTERN.sub(lambda _m: BEGIN + "\n" + payload + "\n" + END, src, count=1)

    print(f"bin   {len(raw)} B")
    print(f"gzip  {len(gz)} B ({len(gz) / 1024:.0f} KiB)")
    print(f"b64   {len(b64)} B ({len(b64) / 1024:.0f} KiB)")
    print(f"脚本  {len(src)} -> {len(out)} 字符 (+{(len(out) - len(src)) / 1024:.0f} KB)")
    if a.dry_run:
        print("dry-run：不写文件")
        return 0
    open(a.script, "w", encoding="utf-8").write(out)
    print("已注入", a.script)
    return 0


if __name__ == "__main__":
    sys.exit(main())