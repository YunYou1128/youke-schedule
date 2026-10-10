# -*- coding: utf-8 -*-
"""PDF 夹具脱敏：把隐私词换成**同长度**的虚构名（等长替换，文件长度不变）。

背景（v1.9.31「E-3」的漏网）：
    `tools/fixtures/` 会随仓库一起公开，里面的真实姓名 / 楼栋必须换成虚构值。
    上一次漏掉了 4 个词，而**判据查不出来** —— 冒烟当时只按字节扫原文件，
    而 PDF 的内容是 Flate 压过的，任何编码的字节比对都命不中：全绿、文件里
    却满是明文。判据已经补上（`smoke-test.js` 的 `privacyLayers`：「摊开再扫」），
    本脚本负责把数据修干净。

为什么不能手工改：
    iText 生成的 PDF 里字符串是 **UCS2BE 明文**、被 Flate 压着。换成同字数的
    中文名后明文等长（CJK 每字 3 字节 UTF-8 / 2 字节 UTF-16），但**重新压缩的
    长度会变** —— 差 1 个字节，`/Length`、xref 偏移、startxref 就全失效了。
    所以做法是：往内容流尾部补换行、换不同的压缩级别去试，直到**压缩后长度与
    原来逐字节相等**。这样除了被替换的那几处字节，文件其余部分一个字节都不动。

真词从哪来：`tools/privacy-words.local.txt`（已被 .gitignore 排除、不进仓库）。
    本脚本**不含任何真词**，替换成什么由上方的 POOL 决定（都是虚构名）。

用法：python tools/desensitize-pdf.py [目标.pdf]
     默认 tools/fixtures/教务系统课表.pdf；幂等，已是干净的就不改动。
"""
import os
import sys
import zlib
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
WORDLIST = os.path.join(HERE, 'privacy-words.local.txt')
DEFAULT_PDF = os.path.join(HERE, 'fixtures', '教务系统课表.pdf')

# 同长度的虚构替换名（**不许**写任何真实信息）。按词表顺序、按长度分桶依次取。
POOL = {
    1: ['甲', '乙'],
    2: ['刘洋', '赵蕾', '明轩', '秦朗', '宋佳', '方昊'],
    3: ['黄志强', '徐嘉诚', '毕文轩'],
    4: ['欧阳志远'],
}
ENCODINGS = ('utf-8', 'utf-16-be', 'utf-16-le')


def load_words():
    if not os.path.exists(WORDLIST):
        sys.exit('缺少 %s —— 真词表不进仓库，本机没有就没法知道要脱敏什么' % WORDLIST)
    words = []
    with open(WORDLIST, encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if s and not s.startswith('#'):
                words.append(s)
    return words


def forms(word):
    return [word.encode(e) for e in ENCODINGS]


def streams_of(buf):
    """[(data_start, data_end, inflated)]，只含能用 zlib 解开的流。"""
    out = []
    i = 0
    while True:
        i = buf.find(b'stream', i)
        if i < 0:
            break
        prev = buf[i - 1:i]
        if i > 0 and (prev.isalnum() or prev == b'_'):     # endstream
            i += 6
            continue
        s = i + 6
        if buf[s:s + 1] == b'\r':
            s += 1
        if buf[s:s + 1] == b'\n':
            s += 1
        e = buf.find(b'endstream', s)
        if e < 0:
            break
        try:
            out.append((s, e, zlib.decompress(buf[s:e])))
        except Exception:
            pass
        i = e + 9
    return out


def fit(plain, target_len):
    """把 plain 压成**恰好** target_len 字节（不够就往尾部补换行）。
    返回 (comp, pad, level)，试不出来返回 None。"""
    for level in (9, 6, 1):
        for pad in range(0, 6000):
            comp = zlib.compress(plain + b'\n' * pad, level)
            if len(comp) == target_len:
                return comp, pad, level
            if len(comp) > target_len + 1:
                break
    return None


def assign(hits):
    """给命中的词分同长度的虚构名（报错信息里不打印真词）。"""
    used, mapping = {}, {}
    for w in hits:
        L = len(w)
        pool = POOL.get(L)
        if not pool:
            sys.exit('有一个 %d 字的词需要替换，但 POOL 里没有同长度的虚构名 —— '
                     '先补 POOL 再跑（不打印该词本身）' % L)
        k = used.get(L, 0)
        mapping[w] = pool[k % len(pool)]
        used[L] = k + 1
    return mapping


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PDF
    raw = open(target, 'rb').read()
    words = load_words()
    streams = streams_of(raw)

    hit = []
    for _s, _e, dec in streams:
        for w in words:
            if w not in hit and any(f in dec for f in forms(w)):
                hit.append(w)
    if not hit:
        print('没有命中 —— 文件已是干净的（幂等，不做改动）')
        return
    mapping = assign(hit)

    out, pos, changed = bytearray(), 0, 0
    for idx, (s, e, dec) in enumerate(streams):
        newdec, cnt = dec, 0
        for w, rep in mapping.items():
            for enc in ENCODINGS:
                a, b = w.encode(enc), rep.encode(enc)
                assert len(a) == len(b), '替换名长度必须与真词一致'
                cnt += newdec.count(a)
                newdec = newdec.replace(a, b)
        if not cnt:
            continue
        old_len = e - s
        fitted = fit(newdec, old_len)
        if fitted is None:
            sys.exit('流 #%d 压不回原长度（%d 字节）—— 需要人工处理' % (idx, old_len))
        comp, pad, level = fitted
        out += raw[pos:s] + comp
        pos = e
        changed += 1
        print('流 #%d：替换 %d 处，补 %d 个换行，压缩级别 %d，长度 %d 不变'
              % (idx, cnt, pad, level, old_len))
    out += raw[pos:]
    new = bytes(out)

    if len(new) != len(raw):
        sys.exit('总长度变了（%d -> %d），不写回' % (len(raw), len(new)))

    bak = os.path.join(tempfile.gettempdir(), os.path.basename(target) + '.bak')
    open(bak, 'wb').write(raw)
    open(target, 'wb').write(new)
    print('已写回 %s（原文件备份到 %s；改动了 %d 个流）' % (target, bak, changed))

    # ---- 自检：解压后的每个流 + 文件骨架，都不许再有词表里的词 ----
    bad, pos2 = [], 0
    for s, e, dec in streams_of(new):
        for w in words:
            if any(f in dec for f in forms(w)):
                bad.append('流:%s' % w)
        for w in words:
            if any(f in new[pos2:s] for f in forms(w)):    # 流与流之间的骨架（ASCII）
                bad.append('骨架:%s' % w)
        pos2 = e
    for w in words:
        if any(f in new[pos2:] for f in forms(w)):
            bad.append('尾部:%s' % w)
    if bad:
        sys.exit('自检失败，正在回滚：' + '、'.join(bad))
    print('自检通过：每个解压流与文件骨架里都不再出现词表里的词')


if __name__ == '__main__':
    main()
