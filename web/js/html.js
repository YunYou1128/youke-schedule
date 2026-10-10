/* ============================================================
   html.js —— 极简 HTML 解析器（零依赖，ES5）
   ------------------------------------------------------------
   用途：把「内嵌浏览器抓回来的教务课表页 HTML」解析成可查询的节点树，
   供 edugrab.js 提取课程。也用于解析用户手动保存下来的 .html 课表。

   为什么自己写而不用 DOMParser：
     1) 抓回来的 HTML 是「主文档 + 所有 iframe 文档」直接首尾拼接的字符串，
        浏览器 DOMParser 会按标签配对规则做修正，反而会吞掉后面那几段；
        本解析器是容错的，会把它们当成同级的兄弟节点，全部保留。
     2) 必须在 Node 环境（离线单测、下载的 html 文件）里也能跑。
     3) 项目一贯零第三方依赖。

   支持的查询能力（够用即可，不是完整 CSS 选择器）：
     tag / #id / .class / [attr] / [attr=v] / [attr^=v] / [attr$=v] / [attr*=v]
     以及「后代（空格）」与「子元素（>）」组合，逗号分隔的多选择器。
   ============================================================ */
(function (global) {
  'use strict';

  /* ------------------------- 常量 ------------------------- */
  var VOID_TAGS = {
    area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
  };

  /* 内容不当标签解析的标签（script/style 里全是 < > 和引号） */
  var RAW_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };

  /* 这些标签遇到同类/同组的新开始标签时，应当先隐式闭合自己 */
  var AUTO_CLOSE = {
    td: { td: 1, th: 1 },
    th: { td: 1, th: 1 },
    tr: { td: 1, th: 1, tr: 1 },
    p: { p: 1 },
    li: { li: 1 },
    option: { option: 1 },
    dt: { dt: 1, dd: 1 },
    dd: { dt: 1, dd: 1 },
    tbody: { tbody: 1, thead: 1, tfoot: 1 }
  };

  /* innerText 时视作换行的块级标签 */
  var BLOCK_TAGS = {
    address: 1, article: 1, aside: 1, blockquote: 1, body: 1, br: 1, dd: 1, div: 1,
    dl: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1,
    h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, html: 1, li: 1, main: 1,
    nav: 1, ol: 1, option: 1, p: 1, pre: 1, section: 1, table: 1, tbody: 1, td: 1,
    tfoot: 1, th: 1, thead: 1, tr: 1, ul: 1
  };

  var NAMED_ENT = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    middot: '\u00B7', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    times: '\u00D7', divide: '\u00F7', deg: '\u00B0', plusmn: '\u00B1',
    sect: '\u00A7', para: '\u00B6', copy: '\u00A9', reg: '\u00AE',
    trade: '\u2122', yen: '\u00A5', euro: '\u20AC', pound: '\u00A3',
    cent: '\u00A2', laquo: '\u00AB', raquo: '\u00BB', ldquo: '\u201C',
    rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019', bull: '\u2022',
    dagger: '\u2020', permil: '\u2030', prime: '\u2032', infin: '\u221E',
    ne: '\u2260', le: '\u2264', ge: '\u2265', ensp: '\u2002', emsp: '\u2003',
    thinsp: '\u2009', shy: '\u00AD', acute: '\u00B4', micro: '\u00B5'
  };

  /* ------------------------- 实体解码 ------------------------- */
  function decode(str) {
    if (str.indexOf('&') < 0) return str;
    return str.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g,
      function (whole, body) {
        if (body.charAt(0) === '#') {
          var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
          var code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
          if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return whole;
          try { return String.fromCodePoint(code); } catch (e) { return whole; }
        }
        var v = NAMED_ENT[body.toLowerCase()];
        return v === undefined ? whole : v;
      });
  }

  /* ------------------------- 节点 ------------------------- */
  function textNode(data) {
    return { nodeType: 3, tagName: '#TEXT', data: data, parent: null };
  }

  function El(tagName, attrs) {
    return {
      nodeType: 1,
      tagName: tagName,            // 统一大写
      attrs: attrs || {},          // 属性名统一小写
      children: [],
      parent: null
    };
  }

  function attr(node, name) {
    if (!node || !node.attrs) return null;
    var v = node.attrs[name.toLowerCase()];
    return v === undefined ? null : v;
  }

  function hasClass(node, cls) {
    var c = attr(node, 'class');
    if (!c) return false;
    return (' ' + c + ' ').indexOf(' ' + cls + ' ') >= 0;
  }

  function childElements(node) {
    var out = [], kids = node.children || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i]);
    return out;
  }

  /* 纯文本拼接（不含 br 换行，行为与浏览器 textContent 一致） */
  function textContent(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.data;
    var s = '', kids = node.children || [];
    for (var i = 0; i < kids.length; i++) s += textContent(kids[i]);
    return s;
  }

  /* 带换行的文本：<br> 与块级标签边界产生 \n，更接近人眼看到的排版 */
  function innerText(node) {
    var parts = [];
    (function walk(n) {
      if (n.nodeType === 3) { parts.push(n.data); return; }
      var tag = n.tagName;
      if (tag === 'BR') { parts.push('\n'); return; }
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      var block = BLOCK_TAGS[tag.toLowerCase()];
      if (block) parts.push('\n');
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) walk(kids[i]);
      if (block) parts.push('\n');
    })(node);
    return parts.join('')
      .replace(/\u00A0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\n+|\n+$/g, '');
  }

  /* ------------------------- 序列化（调试 / 二次解析用） ------------------------- */
  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function outerHTML(node) {
    if (!node) return '';
    if (node.nodeType === 3) {
      return String(node.data).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    var tag = node.tagName.toLowerCase(), out = '<' + tag;
    for (var k in node.attrs) {
      if (Object.prototype.hasOwnProperty.call(node.attrs, k)) {
        out += ' ' + k + '="' + escAttr(node.attrs[k]) + '"';
      }
    }
    out += '>';
    if (VOID_TAGS[tag]) return out;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) out += outerHTML(kids[i]);
    return out + '</' + tag + '>';
  }

  /* ------------------------- 解析 ------------------------- */
  function parseAttributes(raw) {
    var attrs = {}, re = /([^\s=\/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g, m;
    while ((m = re.exec(raw))) {
      var name = m[1].toLowerCase();
      if (name === '/' || name === '') continue;
      var val = m[2];
      if (val === undefined) val = '';
      else if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
               (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
        val = val.slice(1, -1);
      }
      if (attrs[name] === undefined) attrs[name] = decode(val);
    }
    return attrs;
  }

  /**
   * 把 HTML 字符串解析成节点树。
   * 容错策略：
   *   · 未闭合标签在遇到父级闭合标签时自动补全；
   *   · td/th/tr/li/p 等按 HTML 惯例隐式闭合；
   *   · 「主文档 + iframe 文档」首尾拼接的字符串会解析成并列的多个根节点，
   *     不会像 DOMParser 那样丢掉后一段。
   */
  function parse(html) {
    var root = El('#DOCUMENT', {});
    if (html == null) return root;
    html = String(html);
    // 去掉 BOM 与 XML 声明
    if (html.charCodeAt(0) === 0xFEFF) html = html.slice(1);
    html = html.replace(/^\s*<\?xml[^>]*\?>/i, '');

    var stack = [root];
    var top = function () { return stack[stack.length - 1]; };
    var pos = 0, len = html.length;

    function pushText(txt) {
      if (!txt) return;
      var t = textNode(decode(txt));
      t.parent = top();
      top().children.push(t);
    }

    while (pos < len) {
      var lt = html.indexOf('<', pos);
      if (lt < 0) { pushText(html.slice(pos)); break; }
      if (lt > pos) pushText(html.slice(pos, lt));

      /* 注释 / 声明 / CDATA */
      if (html.substr(lt, 4) === '<!--') {
        var ce = html.indexOf('-->', lt + 4);
        pos = ce < 0 ? len : ce + 3;
        continue;
      }
      if (html.substr(lt, 9).toUpperCase() === '<![CDATA[') {
        var de = html.indexOf(']]>', lt + 9);
        pushText(html.slice(lt + 9, de < 0 ? len : de));
        pos = de < 0 ? len : de + 3;
        continue;
      }
      if (html.charAt(lt + 1) === '!' || html.charAt(lt + 1) === '?') {
        var de2 = html.indexOf('>', lt);
        pos = de2 < 0 ? len : de2 + 1;
        continue;
      }

      /* 闭合标签 */
      if (html.charAt(lt + 1) === '/') {
        var gt = html.indexOf('>', lt);
        if (gt < 0) { pos = len; break; }
        var cname = html.slice(lt + 2, gt).trim().toLowerCase().split(/\s/)[0];
        for (var i = stack.length - 1; i > 0; i--) {
          if (stack[i].tagName.toLowerCase() === cname) {
            stack.length = i;            // 连同该元素一起弹出
            break;
          }
        }
        pos = gt + 1;
        continue;
      }

      /* 开始标签 */
      var m = /^<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(html.slice(lt, lt + 64));
      if (!m) { pushText('<'); pos = lt + 1; continue; }

      var tagRaw = m[1].toLowerCase();
      var nameEnd = lt + m[0].length;

      // 找到标签结束的 '>'（跳过引号里的内容）
      var j = nameEnd, quote = 0, selfClose = false;
      while (j < len) {
        var ch = html.charAt(j);
        if (quote) { if (ch === quote) quote = 0; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      if (j >= len) { pushText(html.slice(lt)); break; }

      var rawAttrs = html.slice(nameEnd, j);
      if (/\/\s*$/.test(rawAttrs)) { selfClose = true; rawAttrs = rawAttrs.replace(/\/\s*$/, ''); }

      var el = El(tagRaw.toUpperCase(), parseAttributes(rawAttrs));

      /* 隐式闭合：<td>a<td>b、<p>x<p>y 之类 */
      var ac = AUTO_CLOSE[tagRaw];
      if (ac) {
        while (stack.length > 1) {
          var parentTag = top().tagName.toLowerCase();
          if (ac[parentTag]) stack.pop(); else break;
        }
      }

      el.parent = top();
      top().children.push(el);
      pos = j + 1;

      if (VOID_TAGS[tagRaw] || selfClose) continue;

      /* script / style 内容原样吃进文本节点 */
      if (RAW_TAGS[tagRaw]) {
        var close = html.toLowerCase().indexOf('</' + tagRaw, pos);
        var end = close < 0 ? len : close;
        var raw = html.slice(pos, end);
        if (raw) { var tn = textNode(raw); tn.parent = el; el.children.push(tn); }
        if (close < 0) { pos = len; }
        else {
          var rc = html.indexOf('>', close);
          pos = rc < 0 ? len : rc + 1;
        }
        // script/style 不需要留在树里，直接挂到父节点即可（保留是为了兜底调试）
        continue;
      }

      stack.push(el);
    }

    return root;
  }

  /* ------------------------- 选择器 ------------------------- */
  function parseSimple(str) {
    var s = { tag: null, id: null, classes: [], attrs: [] }, i = 0;
    var tm = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(str);
    if (tm) { s.tag = tm[0].toUpperCase(); i = tm[0].length; }

    while (i < str.length) {
      var c = str.charAt(i);
      if (c === '#') {
        var m1 = /^#([\w-]+)/.exec(str.slice(i));
        if (!m1) break;
        s.id = m1[1]; i += m1[0].length;
      } else if (c === '.') {
        var m2 = /^\.([\w-]+)/.exec(str.slice(i));
        if (!m2) break;
        s.classes.push(m2[1]); i += m2[0].length;
      } else if (c === '[') {
        var end = str.indexOf(']', i);
        if (end < 0) break;
        var body = str.slice(i + 1, end);
        var am = /^([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(body);
        if (am) {
          var v = am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : (am[5] !== undefined ? am[5] : null));
          s.attrs.push({ name: am[1].toLowerCase(), op: am[2] || null, value: v });
        }
        i = end + 1;
      } else { i++; }
    }
    return s;
  }

  function compileGroup(str) {
    var tokens = str.trim().split(/\s+/), steps = [], childNext = false;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i] === '>') { childNext = true; continue; }
      var st = parseSimple(tokens[i]);
      st.childOnly = childNext;
      childNext = false;
      steps.push(st);
    }
    return steps;
  }

  function matchSimple(node, s) {
    if (node.nodeType !== 1) return false;
    if (s.tag && node.tagName !== s.tag) return false;
    if (s.id && attr(node, 'id') !== s.id) return false;
    for (var i = 0; i < s.classes.length; i++) {
      if (!hasClass(node, s.classes[i])) return false;
    }
    for (var k = 0; k < s.attrs.length; k++) {
      var a = s.attrs[k], val = attr(node, a.name);
      if (val === null) return false;
      if (a.op === '=' && val !== a.value) return false;
      if (a.op === '^=' && val.indexOf(a.value) !== 0) return false;
      if (a.op === '$=' && val.slice(-a.value.length) !== a.value) return false;
      if (a.op === '*=' && val.indexOf(a.value) < 0) return false;
    }
    return true;
  }

  function matchSteps(node, steps, idx) {
    if (!matchSimple(node, steps[idx])) return false;
    if (idx === 0) return true;
    if (steps[idx].childOnly) {
      var p = node.parent;
      return !!(p && p.nodeType === 1 && matchSteps(p, steps, idx - 1));
    }
    var q = node.parent;
    while (q && q.nodeType === 1) {
      if (matchSteps(q, steps, idx - 1)) return true;
      q = q.parent;
    }
    return false;
  }

  function querySelectorAll(root, selector) {
    var groups = String(selector).split(',').map(compileGroup).filter(function (g) { return g.length; });
    var out = [];
    if (!groups.length) return out;
    (function walk(n) {
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType !== 1) continue;
        for (var g = 0; g < groups.length; g++) {
          if (matchSteps(k, groups[g], groups[g].length - 1)) { out.push(k); break; }
        }
        walk(k);
      }
    })(root);
    return out;
  }

  function querySelector(root, selector) {
    var r = querySelectorAll(root, selector);
    return r.length ? r[0] : null;
  }

  function getElementsByTagName(root, name) {
    name = name.toUpperCase();
    var out = [];
    (function walk(n) {
      var kids = n.children || [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.nodeType !== 1) continue;
        if (name === '*' || k.tagName === name) out.push(k);
        walk(k);
      }
    })(root);
    return out;
  }

  /** 祖先链查找（含自身可选） */
  function closest(node, selector) {
    var groups = String(selector).split(',').map(compileGroup).filter(function (g) { return g.length; });
    var n = node;
    while (n && n.nodeType === 1) {
      for (var g = 0; g < groups.length; g++) {
        if (matchSteps(n, groups[g], groups[g].length - 1)) return n;
      }
      n = n.parent;
    }
    return null;
  }

  global.HtmlUtil = {
    parse: parse,
    decode: decode,
    attr: attr,
    hasClass: hasClass,
    text: textContent,
    innerText: innerText,
    outerHTML: outerHTML,
    childElements: childElements,
    querySelector: querySelector,
    querySelectorAll: querySelectorAll,
    getElementsByTagName: getElementsByTagName,
    closest: closest,
    VOID_TAGS: VOID_TAGS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.HtmlUtil;

})(typeof window !== 'undefined' ? window : globalThis);
