# -*- coding: utf-8 -*-
"""
本机隐私词表读取（冒烟测试 / APK 核验脚本共用）。

为什么要单独一个模块，而不是把词直接写在断言里：
    「源码里不许出现真实姓名」这句判据，如果为了能检查，就把真实姓名原样
    抄进断言，那这条断言本身就成了泄露源 —— 仓库一开源，它就在公网上。
    所以真词表放在 `tools/privacy-words.local.txt`（已被 .gitignore 排除、
    只在维护者本机存在），代码里只留读取逻辑。

关键约定（改了要同步 smoke-test.js 的 [C-7] 段）：
  · 没有本机词表时 load_words() 返回空列表，调用方**打印「跳过」而不是失败** ——
    别人 clone 仓库、删掉那份表，测试照样要能全绿。
  · 词表里的词会同时在 UTF-8 / UTF-16LE / UTF-16BE 三种编码下比对。
    `.xls`（BIFF8 的 SST）与 `.pdf`（UCS2 字面串）里的字符串是 UTF-16，
    只按 UTF-8 查会得到「查不出」的假绿。
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_TXT = os.path.join(HERE, 'privacy-words.local.txt')


def load_words(path=None):
    """读词表。文件不存在或没有有效行时返回 []。"""
    p = path or LOCAL_TXT
    if not os.path.exists(p):
        return []
    words = []
    with open(p, 'r', encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            words.append(s)
    return words


def encodings(word):
    """一个词要按这几种编码去找。UTF-16BE 少见于本工程的产物，但一并扫。"""
    return [('utf-8', word.encode('utf-8')),
            ('utf-16le', word.encode('utf-16-le')),
            ('utf-16be', word.encode('utf-16-be'))]


def hits_in(buf, words, decode_text=None):
    """在 bytes 或 str 里找词。返回命中的词列表。

    decode_text 给的是「已经按 utf-8 解出来的文本」，None 表示只按 bytes 比。
    """
    found = []
    for w in words:
        if decode_text is not None and w in decode_text:
            found.append(w)
            continue
        for _enc, raw in encodings(w):
            if raw and raw in buf:
                found.append(w)
                break
    return found


def skip_note(label='隐私词表'):
    return '%s缺失（tools/privacy-words.local.txt 不在本机）→ 跳过' % label
