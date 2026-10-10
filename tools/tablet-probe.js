/**
 * 平板布局探针（临时诊断用）：在几种视口下打开「每节起止时间」整页，
 * 把关键几何量打出来并截图，用来定位「内容顶到状态栏 / 按钮难点」的真实成因。
 *
 * 用法： node tools/tablet-probe.js
 * 截图输出到系统临时目录（不是交付物，不进 dist/）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
const pageUrl = 'file:///' + path.join(root, 'web', 'index.html').replace(/\\/g, '/');
const outDir = path.join(os.tmpdir(), 'tablet-probe');
const PORT = 9700 + (process.pid % 200);
const profile = path.join(os.tmpdir(), 'tablet-probe-profile-' + process.pid);

/* 每种场景：名字 / 视口 / 模拟原生下发的安全区（null = 没有桥，回退 env()） */
const CASES = [
  { name: '手机-竖屏', w: 390, h: 844, safe: { top: 24, bottom: 48 } },
  { name: '平板-竖屏', w: 800, h: 1280, safe: { top: 26, bottom: 48 } },
  { name: '平板-横屏', w: 1072, h: 776, safe: { top: 26, bottom: 48 } },
  { name: '平板-横屏-无桥', w: 1072, h: 776, safe: null },
  { name: '手机-横屏', w: 844, h: 390, safe: { top: 24, bottom: 0 } },
  { name: '横屏矮屏', w: 740, h: 360, safe: { top: 24, bottom: 0 } }
];

const DUMP = `JSON.stringify((function(){
  var q=function(s){var e=document.querySelector(s); if(!e) return null; var b=e.getBoundingClientRect();
    return {t:+b.top.toFixed(1),l:+b.left.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),
            b:+b.bottom.toFixed(1),r:+b.right.toFixed(1)};};
  var de=document.documentElement;
  var body=document.querySelector('#maskTimetable .page-body');
  return {
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    docW: de.scrollWidth, docH: de.scrollHeight, cliW: de.clientWidth, cliH: de.clientHeight,
    safeTop: getComputedStyle(de).getPropertyValue('--safe-top').trim(),
    safeBottom: getComputedStyle(de).getPropertyValue('--safe-bottom').trim(),
    bodyScrollTop: body ? Math.round(body.scrollTop) : null,
    bodyScrollH: body ? body.scrollHeight : null,
    mask: q('#maskTimetable'), page: q('#maskTimetable .page'),
    head: q('#maskTimetable .page-head'), pbody: q('#maskTimetable .page-body'),
    card: q('#maskTimetable .card'),     tgl: q('#maskTimetable #ttFixed'),
    tglBox: q('#maskTimetable .switch'),
    maskStyle: (function(){var e=document.getElementById('maskTimetable');if(!e)return null;
      var s=getComputedStyle(e);return {display:s.display,alignItems:s.alignItems,
        justifyContent:s.justifyContent,flexDirection:s.flexDirection,
        position:s.position,height:s.height,'min-height':s.minHeight};})(),
    pageStyle: (function(){var e=document.querySelector('#maskTimetable .page');if(!e)return null;
      var s=getComputedStyle(e);return {alignSelf:s.alignSelf,height:s.height,
        'min-height':s.minHeight,'max-height':s.maxHeight,flex:s.flex,
        position:s.position,transform:s.transform,zoom:s.zoom,width:s.width,
        display:s.display,overflow:s.overflow};})()
  };})())`;

let child = null;

(async () => {
  if (!browser) throw new Error('未找到 Edge / Chrome');
  fs.mkdirSync(outDir, { recursive: true });

  child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { target = page; break; }
    } catch (e) { /* 端口未就绪 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error('调试端口未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let loaded = false;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rj(new Error(msg.error.message)) : rs(msg.result);
      } else if (msg.method === 'Page.loadEventFired') { loaded = true; }
    });
  });

  let seq = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await send('Page.enable');
  await send('Runtime.enable');

  for (const c of CASES) {
    const bridge = c.safe
      ? 'window.AndroidSafeArea={insets:function(){return ' +
        JSON.stringify(JSON.stringify({ top: c.safe.top, bottom: c.safe.bottom, left: 0, right: 0 })) +
        ';}};'
      : '';
    await send('Page.addScriptToEvaluateOnNewDocument', { source: bridge + 'window.__stub=1;' });
    await send('Emulation.setDeviceMetricsOverride', {
      width: c.w, height: c.h, deviceScaleFactor: 2, mobile: c.w < 600
    });
    loaded = false;
    await send('Page.navigate', { url: pageUrl });
    for (let i = 0; i < 80 && !loaded; i++) await wait(100);
    await wait(700);

    await evalJs('window.closeAllMasks&&window.closeAllMasks();1');
    await evalJs('document.getElementById("btnSettings").click();1');
    await wait(320);
    await evalJs('document.getElementById("btnTimes").click();1');
    await wait(420);

    const g = JSON.parse(await evalJs(DUMP));
    console.log('\n=== ' + c.name + ' (' + c.w + '×' + c.h + ') safe=' +
      (c.safe ? 'top ' + c.safe.top + ' / bottom ' + c.safe.bottom : '无桥') + ' ===');
    console.log(JSON.stringify(g, null, 1));

    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const f = path.join(outDir, c.name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  · ' + f);
  }

  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('探针失败：' + e.message);
  if (child) child.kill();
  process.exit(1);
});
