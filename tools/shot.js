/**
 * 通过 CDP 精确模拟手机视口截图（Edge 的 --window-size 有最小宽度限制，无法直接模拟 390px）。
 *
 * 用法： node tools/shot.js <url> <输出png> [宽] [高] [缩放]
 * 例：   node tools/shot.js file:///X:/preview-sched/preview.html X:/preview-sched/shot.png 390 844 2
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find(p => fs.existsSync(p));

const url = process.argv[2];
const outPath = process.argv[3] || path.join(os.tmpdir(), 'shot.png');
const width = parseInt(process.argv[4], 10) || 390;
const height = parseInt(process.argv[5], 10) || 844;
const dpr = parseFloat(process.argv[6]) || 2;

const PORT = 9333 + (process.pid % 500);
const profile = path.join(os.tmpdir(), 'sched-shot-' + process.pid);

let child = null;

function connect(ws, onMessage) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', e => reject(new Error('ws error')));
    ws.addEventListener('message', ev => onMessage(JSON.parse(ev.data)));
  });
}

(async () => {
  if (!browser) throw new Error('未找到 Edge/Chrome');

  child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  /* 等待调试端口 */
  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page) { targets = page; break; }
    } catch (e) { /* 端口未就绪 */ }
    await new Promise(r => setTimeout(r, 150));
  }
  if (!targets) throw new Error('调试端口未就绪');

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  const pending = new Map();
  let loaded = false;

  await connect(ws, msg => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Page.loadEventFired') {
      loaded = true;
    }
  });

  let seq = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = seq++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: true
  });
  await send('Page.navigate', { url });

  for (let i = 0; i < 60 && !loaded; i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 700));

  const metrics = await send('Runtime.evaluate', {
    expression: '(function(){var s=document.getElementById("schedule"),gw=document.getElementById("gridWrap");' +
      'var hr=document.querySelector(".head-row"),dc=document.querySelector(".day-col");' +
      'return JSON.stringify({viewportW:innerWidth,viewportH:innerHeight,appW:document.getElementById("app").offsetWidth,' +
      'scheduleW:s.offsetWidth,dayColW:dc?dc.offsetWidth:0,gridWrapH:gw.clientHeight,gridWrapW:gw.clientWidth,' +
      'headH:hr?hr.offsetHeight:0,rowH:getComputedStyle(document.documentElement).getPropertyValue("--row-h").trim(),' +
      'bodyScrollW:document.body.scrollWidth,bodyScrollH:document.body.scrollHeight,rowsVisible:Math.floor(gw.clientHeight/(hr?hr.offsetHeight:0))})})()',
    returnByValue: true
  });
  console.log('视口 ' + width + 'x' + height + ' @' + dpr + 'x  ' + metrics.result.value);

  /* PROBE=表达式 时只输出页面探测结果，不截图（支持返回 Promise 的异步探测） */
  if (process.env.PROBE) {
    let r;
    try {
      r = await send('Runtime.evaluate', {
        expression: 'Promise.resolve(' + process.env.PROBE + ')',
        returnByValue: true, awaitPromise: true
      });
    } catch (e) {
      r = await send('Runtime.evaluate', { expression: process.env.PROBE, returnByValue: true });
    }
    if (r.exceptionDetails) {
      console.log('探测异常：' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails));
      return;
    }
    console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 1));
    return;
  }

  /* PROBE_BEFORE=表达式 时先执行页面交互（如点开弹层），再截图 */
  if (process.env.PROBE_BEFORE) {
    await send('Runtime.evaluate', { expression: process.env.PROBE_BEFORE, returnByValue: true });
    await new Promise(r => setTimeout(r, 650));
  }

  /* CLIP="x,y,w,h"（CSS 像素）时只截取该区域，配合 dpr 可放大核查细节 */
  const shotParams = { format: 'png', fromSurface: true };
  if (process.env.CLIP) {
    const [x, y, w, h] = process.env.CLIP.split(',').map(Number);
    shotParams.clip = { x, y, width: w, height: h, scale: 1 };
    shotParams.captureBeyondViewport = true;
  }

  const shot = await send('Page.captureScreenshot', shotParams);
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('已保存：' + outPath + '  (' + (fs.statSync(outPath).size / 1024).toFixed(0) + ' KB)');

  ws.close();
})().catch(e => {
  console.error('截图失败：' + e.message);
  process.exitCode = 1;
}).finally(() => {
  if (child && !child.killed) { try { child.kill(); } catch (e) {} }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});
