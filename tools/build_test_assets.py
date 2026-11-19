#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""build_test_assets.py — 把「脚本里的真实解码模块」和「真实密文样本」导成浏览器可测的资产。

产物（默认输出到 autocx/test/fontdec/）：
  fontdec-module.js  ← 从 学习通助手.user.js 的 AUTOCX-FONTDEC 标记之间原样抽出
  fixture-art.js     ← { ttf: base64, cases: [[密文, 期望明文], ...] }（艺术导论 7.1 真题）

这样 harness 测的就是脚本里那一段代码本身，不是复制品。
"""
import base64
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "学习通助手.user.js")

# 2026-11-19 艺术导论 7.1 章节测验实测抓到的密文 -> 明文（明文已按"部首->正字"规范化）
CASES = [
    ["拞拠派拣拡萚拧拤()。", "印象派最追求的是()。"],
    ["拪和拫", "光和色"],
    ["拪和葀", "光和影"],
    ["拯实", "真实"],
    ["拰幻", "虚幻"],
    ["艺术洘格拳珙拲拶成的原因拵拴()。", "艺术风格多样性形成的原因包括()。"],
    ["艺湁跩拹拻的拸拺个拲", "艺术家独特的创作个性"],
    ["艺湁跩拹拻的挃挄道挀", "艺术家独特的人生道路"],
    ["挅挆需萚拧拳珙挈", "审美需求的多样化"],
    ["挊上挋拤", "以上都是"],
    ["挏挒传挍媒介挎通过()和()来达挐挏挒化拧目标。", "大众传播媒介要通过()和()来达到大众化的目标。"],
    ["挓湁风格挕要挔向的挓湁家个体,而挓湁流派则挕要挔向一挗挓湁家。",
     "艺术风格主要指向的艺术家个体,而艺术流派则主要指向一群艺术家。"],
]


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "test", "fontdec")
    src = open(SCRIPT, encoding="utf-8").read()

    m = re.search(r"// >>> AUTOCX-FONTDEC-BEGIN(.*?)// <<< AUTOCX-FONTDEC-END", src, re.S)
    if not m:
        print("找不到 AUTOCX-FONTDEC 标记", file=sys.stderr)
        return 1
    code = m.group(1)
    if "function createFontDeobfuscator" not in code:
        print("抽出来的片段里没有 createFontDeobfuscator", file=sys.stderr)
        return 1

    mod_path = os.path.join(out_dir, "fontdec-module.js")
    with open(mod_path, "w", encoding="utf-8") as f:
        f.write("/* 由 build_test_assets.py 从 学习通助手.user.js 原样抽出，勿手改 */\n")
        f.write(code.strip() + "\n")

    font_b64_path = os.path.join(out_dir, "captured", "cxsecret_font.txt")
    ttf_b64 = open(font_b64_path, encoding="utf-8").read().strip()

    fix_path = os.path.join(out_dir, "fixture-art.js")
    with open(fix_path, "w", encoding="utf-8") as f:
        f.write("window.__ART = ")
        json.dump({"font": ttf_b64, "cases": CASES}, f, ensure_ascii=False)
        f.write(";\n")

    # 内联库（脚本里那段 gzip base64）单独倒出来，供 harness-inline.html 验证"断网也能解"
    m2 = re.search(r"const REFDB_GZ = '([A-Za-z0-9+/=]+)'", src)
    if m2:
        inline_path = os.path.join(out_dir, "fixture-inline.js")
        with open(inline_path, "w", encoding="utf-8") as f:
            f.write("window.__INLINE_GZ = '" + m2.group(1) + "';\n")
        print(f"inline  {len(m2.group(1))} b64 chars -> {inline_path}")
    else:
        print("（脚本里还没有内联参考库，跳过 fixture-inline.js）", file=sys.stderr)

    print(f"module  {len(code)} chars -> {mod_path}")
    print(f"fixture {len(CASES)} cases, font {len(ttf_b64)} b64 chars -> {fix_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())