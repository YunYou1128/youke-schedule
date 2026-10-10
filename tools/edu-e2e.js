/**
 * 端到端验证「从教务系统导入」这条链路。
 *
 * 做法：用无头浏览器打开 web/index.html（真实页面，不是桩），
 *       把 tools/fixtures/edu-kb-newzf.html（模拟一份教务导出的网页课表）
 *       交给 window.ScheduleApp.onEduBuffer()——这正是原生侧把下载/抓到的文件
 *       回灌给网页时调用的同一个入口，然后检查导入预览 → 点「导入」→
 *       课表是否真的渲染出课程，并顺便截图。
 *
 * ⚠️ v1.9.43 换了入口：原来是 onEduHtml(html, url)（原生抓整页 HTML 回传），
 *    那条通道连着「自研抓页」一起拆掉了。改成把同一份 HTML 当**文件**送进
 *    onEduBuffer(base64, fileName) —— 两条路的**下游完全一样**
 *    （sniff → parseHtml → applyImport），所以这里验的导入预览 / 覆盖 /
 *    追加 / 字段逐条核对**一条都没少**，换的只是送进来的那一道门。
 *    （来源里的域名原来由 url 拼、现在由文件名带，就这一处判据跟着改了。）
 *
 * 用法： node tools/edu-e2e.js
 * 产物： docs/screenshots/图15-教务导入预览-v1.8.1.png
 *        docs/screenshots/图16-教务导入结果-v1.8.1.png
 *        docs/screenshots/图17-打开教务系统-v1.9.36.png
 *        docs/screenshots/图18-手动填学校-v1.8.4.png
 *        docs/screenshots/图46-分享课表-v1.9.20.png
 *        docs/screenshots/图47-清空课表确认框-v1.9.20.png
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const browser = BROWSERS.find((p) => fs.existsSync(p));

/* 截图落到 docs/screenshots/ —— 这里的素材全部是**虚构样例**（见 tools/fixtures），
   所以可以直接随仓库公开；dist/ 是构建产物、已被 .gitignore 排除。 */
const outDir = path.join(root, 'docs', 'screenshots');
const fixture = fs.readFileSync(path.join(root, 'tools', 'fixtures', 'edu-kb-newzf.html'), 'utf8');
const pageUrl = 'file:///' + path.join(root, 'web', 'index.html').replace(/\\/g, '/');
/* v1.9.43 删掉了 EDU_URL —— 它原来当 onEduHtml 的第二个参数（用来在预览里
   标出「页面来自哪个域名」）。改成文件入口之后，域名由**文件名**带着走，
   见下面 asFile() 的第二个参数。 */

const PORT = 9400 + (process.pid % 400);
const profile = path.join(os.tmpdir(), 'edu-e2e-' + process.pid);

/* 清掉以前跑剩下的临时 profile（只认 `edu-e2e-` 前缀、且超过 1 小时没用过的）。
   ⚠️ **只在收尾调用，而且每次限量** —— 第一版是放在**开头**做全量扫描的，
   结果它自己变成了新的「无声挂起」：攒下上百个目录、每个都是完整的 Chrome
   用户目录（成千上万个文件），同步 `rmSync` 要磨好几分钟，而这几分钟里
   **一个字都还没输出** —— 恰好是我这一版要消灭的那个形状。 */
function sweepOldProfiles(max) {
  try {
    const tmp = os.tmpdir();
    const dead = fs.readdirSync(tmp).filter((n) => n.indexOf('edu-e2e-') === 0)
      .filter((n) => {
        try { return Date.now() - fs.statSync(path.join(tmp, n)).mtimeMs > 3600 * 1000; }
        catch (e) { return false; }
      })
      .slice(0, max || 2);
    dead.forEach((n) => {
      const p = path.join(tmp, n);
      if (p !== profile) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }
    });
    return dead.length;
  } catch (e) { return 0; }
}

let child = null;
let pass = 0, fail = 0;

/* ---------- 「挂住了 / 崩了」都不能长得像「全绿」 ----------
   下游只认 `✘` 行，「一条 ✘ 都没有」会被读成「全绿」。而这个脚本原先有两个
   口子能产出「没有结论的退出」：

   ① **崩了**：顶层 catch 只打一行 `端到端测试失败：…`，没有 ✘ 行
      （与冒烟测试同一个坑，那边早就有出口哨兵了，这边一直没有）；
   ② **挂住了**：更糟 —— 不报错、不退出、输出停在上一行，只能人工 kill。
      本轮实测连着踩到两次（一次停在 `Emulation.setTouchEmulationEnabled`
      之后的某条 CDP 调用上，日志五分钟一个字没涨），两次的日志都没有结尾、
      也没有任何失败标记 ⇒ **被读成「跑过了，没红」**。

   所以这里两头都堵上：出口哨兵负责 ①、send() 的超时与连接断开处理负责 ②。

   ⚠️ **实测到的偶发率：五次里三次**（插桩那轮与 r2 都 306/0；另外三次都挂在
   `Emulation.setTouchEmulationEnabled` 之后**第一条** `Input.dispatchTouchEvent`
   上，其中一次连鼠标长拖那两条也真红了 —— 都是「一连串输入事件发出去、渲染端
   没接住」的同一类形状）。**已排掉的**：机器没进过睡眠（查了 Kernel-Power 事件）、
   跟平板视口的 `setDeviceMetricsOverride` 无关（那一段在 `[13]` 之后）、浏览器进程
   当时活着（调试端口在听、WS 是 ESTABLISHED）、不是页面代码的问题（最小页面与
   真页面的**独立**复现都过）。**试过但证伪的**：Windows「窗口被遮挡 ⇒ 渲染进程降级」
   —— 四个抗降级开关加上去之后**两跑两挂**，已撤掉（不留没用的旋钮）。
   现在按「目标没被激活 / 文档没焦点」这条改（`Page.bringToFront` +
   `Emulation.setFocusEmulationEnabled`）。
   **操作口径不变：e2e 要单独跑（别和构建并发），红了先重跑一次再当失败**；
   但无论哪种情形，它都不会再伪装成全绿。

   ⚠️⚠️ **同一版里我自己又踩了一次同类坑，记在这里当规矩**：为了回收临时 profile，
   第一稿在**开头**做**全量同步 `rmSync`**（这台机器上攒了 132 个，每个都是完整的
   Chrome 用户目录）⇒ 开跑前先磨几分钟删目录，而这几分钟里**一个字都没输出**，
   和「挂住了」长得**一模一样**（我诊断时自己都误判过一次）。现在的做法是
   **只在收尾做、每次限量**，并且**起浏览器之前先打一行**（见下面的启动打印）——
   只要进程还活着，输出里就一定已经有东西了。
   顺带同一个病还找到一处：WebSocket 打开那步原本是**没有超时的裸 `await`**。
   **规矩：脚本里每一个可能不 settle 的 `await` 都必须有超时。** */
let runFinished = false;
process.on('exit', function () {
  if (!runFinished) {
    console.log('\n  ✘ 端到端测试没跑完就退出了（CDP 调用超时 / 浏览器没起来 / 进程被杀）'
      + '  -> 上面的通过数不代表全貌，必须当成失败处理');
  }
});
function check(name, cond, extra) {
  if (cond) { console.log('  ✔ ' + name); pass++; }
  else {
    console.log('  ✘ ' + name + (extra !== undefined ? '  -> ' + extra : ''));
    fail++;
  }
}

/* 极小的 PNG 解码器（只用 zlib，8bit、非隔行、RGB / RGBA）。
   为什么要自己解：有的改动**只看 CSS 是发现不了的**——白边在纯白底上是「白压白」、
   描边顺序写反会被盖掉，这时 computed style 依然是漂亮的一条 box-shadow。
   只有把截图里的像素读出来数一数，才知道它到底画没画、画在哪一层。
   （上一版 v1.9.7 的白边问题就是靠肉眼看截图才发现的，这次把它变成断言。） */
function decodePng(buf) {
  if (buf.length < 26 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ct = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error('不支持的 PNG bd=' + bd + ' ct=' + ct);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w: w, h: h, bpp: bpp, data: out };
}

/* 卡片底色的可读性可以直接量：把 computed 的 rgb() 拎出来算 WCAG 相对亮度，
   再对白字求对比度。「实心纯色底 + 白字」这件事不该只靠肉眼看截图。 */
function lumOf(rgbStr) {
  const m = /rgba?\(([^)]+)\)/.exec(String(rgbStr));
  if (!m) return NaN;
  const p = m[1].split(',').map((v) => parseFloat(v));
  const lin = p.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
const contrastWhite = (bg) => 1.05 / (lumOf(bg) + 0.05);

(async () => {
  if (!browser) throw new Error('未找到 Edge / Chrome');
  /* 先打一行再干活。理由很实际：这一版第一稿把「清旧的临时 profile」放在开头做
     全量同步删除，磨了几分钟而**一个字都没输出** ⇒ 又长成了「无声挂起」的样子。
     从现在起，只要进程活着，输出里就一定已经有东西了。 */
  console.log('· 启动浏览器 ' + path.basename(browser) + '，调试端口 ' + PORT);

  child = spawn(browser, [
    /* `--disable-gpu` 保留：新 headless 本来就走软件合成，显式关掉少一条变量。
       ⚠️ **试过、但没用的**：那四个抗降级开关（`--disable-background-timer-throttling`
       / `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding`
       / `--disable-features=CalculateNativeWinOcclusion`）加进来之后**两跑两挂**，
       比不加还差 ⇒ 已撤掉。「窗口被系统判成被遮挡」这条假设**证伪**了，不留没用的旋钮。 */
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

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
    /* 这里原本是**没有超时的裸 await** —— 连不上而且 'error' 又不发的时候会一直挂着，
       和 send() 是同一类缺口，一并堵上。 */
    const tt = setTimeout(() => reject(new Error('WebSocket 连接超时（10s 没打开）')), 10000);
    ws.addEventListener('open', () => { clearTimeout(tt); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(tt); reject(new Error('ws error')); });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: rs, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rj(new Error(msg.error.message)) : rs(msg.result);
      } else if (msg.method === 'Page.loadEventFired') {
        loaded = true;
      }
    });
  });

  let seq = 1;
  /* 每条 CDP 调用都必须有超时（理由见文件头那段「挂住了不能长得像全绿」）。
     15s 是宽松值：单条调用正常都在毫秒级，到这个量级只可能是真卡住了。 */
  const SEND_TIMEOUT_MS = 15000;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = seq++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 调用超时（' + SEND_TIMEOUT_MS + 'ms 没有回应）：' + method
        + '　—— 浏览器可能已不再回应；这条之后还剩 ' + pending.size + ' 条在途'));
    }, SEND_TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  /* 连接断掉的话，已经在途的调用不会再有回应 —— 一并拒绝，
     否则它们会一直挂在 pending 里等超时（甚至永远等下去）。 */
  ws.addEventListener('close', () => {
    Array.from(pending.keys()).forEach((id) => {
      const p = pending.get(id);
      pending.delete(id);
      p.reject(new Error('调试连接已断开，这条调用不会有回应（#' + id + '）'));
    });
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description ||
        JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('  · 已保存 ' + path.relative(root, file));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 把一段 HTML 当「教务导出的文件」送进网页侧（v1.9.43 起唯一的那条回灌路径）。
     base64 在 Node 这边算好 —— 网页侧的 onEduBuffer 收到之后走 atob → 字节 →
     sniff → parseHtml，与真实下载下来的文件完全同一条路。
     文件名带上域名：预览里的「来源」后缀就是从它来的（原来在 url 参数上）。 */
  const asFile = (html, name) =>
    'window.ScheduleApp.onEduBuffer(' +
    JSON.stringify(Buffer.from(String(html), 'utf8').toString('base64')) + ',' +
    JSON.stringify(name || 'jwgl.example.edu.cn.html') + ');1';

  await send('Page.enable');
  await send('Runtime.enable');

  /* 桌面小组件的桥，在**页面加载前**桩上。
     原生侧那半边是 addJavascriptInterface("AndroidWidget")，浏览器里没有它，
     页面的 pushWidget 会静默跳过 —— 那也意味着「推没推、推得对不对」
     在真实浏览器里根本测不到。桩住它，每次写盘后的推送就都留了痕，
     末尾 [21] 段再逐条验 payload 的内容。 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__widgetPushes = [];' +
      'window.AndroidWidget = {' +
      '  sync: function (j) { window.__widgetPushes.push(j); }' +
      '};'
  });

  /* 把目标页「拉到前台」并让文档拿到焦点。
     这一条是冲着一个**具体症状**加的：`[13]` 段里 `Emulation.setTouchEmulationEnabled`
     之后的第一条 `Input.dispatchTouchEvent` **偶发地永远不回来**（挂到 15s 超时）。
     最小页面能复现、独立跑真页面也能过 ⇒ 不是页面代码的问题；剩下最像的就是
     「目标没有被激活 / 文档没有焦点」——触摸事件的应答要等渲染端确认，
     而鼠标那条路径不需要。两条都是 CDP 的标准做法（Puppeteer 也这么干）。 */
  await send('Page.bringToFront', {});
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: pageUrl });
  for (let i = 0; i < 80 && !loaded; i++) await wait(100);
  await wait(700);

  console.log('\n[1] 页面与桥接口就绪');
  check('课表页面加载完成', !!(await evalJs('!!window.ScheduleApp')));

  /* ---- 原生侧拿到课表页之后，就是调用这个入口交给网页 ---- */
  console.log('\n[2] 交付教务课表页（等同原生侧 onEduBuffer，v1.9.43 起唯一入口）');
  await evalJs(asFile(fixture, 'jwgl.example.edu.cn.html'));
  await wait(700);

  check('导入弹层自动打开', await evalJs('document.getElementById("maskImport").classList.contains("show")'));

  const preview = await evalJs('document.getElementById("importResult").innerText');
  console.log('  ── 预览内容 ──\n' + preview.split('\n').map((l) => '  | ' + l).join('\n'));

  check('识别到 15 门课程', /15\s*门课程/.test(preview), preview.slice(0, 80));
  check('来源标注为教务系统网页', /教务系统网页/.test(preview), preview.slice(0, 80));
  /* v1.9.43：域名不再由 url 参数拼进来源，而是**随文件名**一起到
     （'jwgl.example.edu.cn.html'）—— 判据不变，只是它现在验的是
     「文件名有没有被如实写进来源」。 */
  check('来源带上了学校域名（来自文件名）', /jwgl\.example\.edu\.cn/.test(preview));
  check('给出了目标课表', /目标课表/.test(preview));
  check('解析提示里说明了识别到的表格', /kbgrid_table_0/.test(preview));
  check('没有出现解析错误', !/警告：/.test(preview), preview);

  await shot(path.join(outDir, '图15-教务导入预览-v1.8.1.png'));

  console.log('\n[3] 点「导入到课表」');
  const clicked = await evalJs(
    '(function(){var b=document.querySelector("#importResult [data-imp]");' +
    'if(!b) return "";b.click();return b.getAttribute("data-imp");})()'
  );
  check('存在导入按钮且被点击', clicked === 'replace', clicked);
  await wait(600);

  const cards = await evalJs('(document.getElementById("schedule").innerHTML.match(/class="course"/g)||[]).length');
  check('课表渲染出课程卡片', cards > 0, cards + ' 张');

  const after = await evalJs('document.getElementById("importResult").innerText');
  check('提示导入成功', /已导入\s*15\s*门课程/.test(after), after.split('\n')[0]);

  const names = await evalJs(
    'JSON.stringify(window.ScheduleApp.state.courses.map(function(c){return c.name}))'
  );
  const arr = JSON.parse(names);
  check('课程数据落库为 15 条', arr.length === 15, arr.length);
  check('含「高等数学A」', arr.indexOf('高等数学A') >= 0);
  check('含「Web前端开发」', arr.indexOf('Web前端开发') >= 0);
  check('含「自习」（无教师也能导入）', arr.indexOf('自习') >= 0);

  const math = JSON.parse(await evalJs(
    'JSON.stringify(window.ScheduleApp.state.courses.filter(function(c){return c.name==="高等数学A"})[0]||null)'
  ));
  check('高等数学A 字段：周一 1-2 节 / 张建国 / 教三-301',
    !!math && math.day === 1 && math.start === 1 && math.end === 2 &&
    math.teacher === '张建国' && math.location === '教三-301',
    JSON.stringify(math));

  const topName = await evalJs('document.getElementById("curSchedName").textContent');
  check('顶栏显示当前课表名', !!topName, topName);

  // 关掉导入弹层，截一张干净的课表（用当前这一周，能看到刚导入的课）
  await evalJs('document.getElementById("btnImportClose").click();1');
  await wait(500);
  check('关闭弹层后弹层已收起',
    !(await evalJs('document.getElementById("maskImport").classList.contains("show")')));
  await shot(path.join(outDir, '图16-教务导入结果-v1.8.1.png'));

  console.log('\n[4] 导入失败时的提示（选错文件的场景）');
  await evalJs(asFile('<html><body><div>用户登录</div></body></html>', 'login.html'));
  await wait(500);
  const bad = await evalJs('document.getElementById("importResult").innerText');
  check('给出「页面里没有课表」的指引', /没有课表/.test(bad), bad.split('\n')[0]);
  check('指引里告诉用户该去哪个页面', /学生个人课表|我的课表/.test(bad));

  /* v1.8：有「星期」但没有「节次」——正方课表默认不显示时间 / 教室 / 教师，
     这是「导入失败」里最常见的一种。要能把用户指到课表页的齿轮设置上。 */
  console.log('\n[5] 课表没显示节次时的指引');
  await evalJs(asFile('<html><body><div>课表查询</div>' +
    '<p>星期一 星期二 星期三</p></body></html>', 'menu.html'));
  await wait(500);
  const gear = await evalJs('document.getElementById("importResult").innerText');
  check('提示去课表页齿轮里打开「显示上课时间 / 教室 / 教师」',
    /齿轮/.test(gear) && /上课时间/.test(gear), gear.split('\n')[0]);
  check('同时给出各变体的尝试记录便于回传定位', /解析尝试记录/.test(gear));

  /* v1.8 新增的变体：正方新版「教学管理信息服务平台」的列表式课表
     （一行一门课，没有「星期表头 + 左侧节次」的网格结构） */
  console.log('\n[6] 列表式课表（一行一门课）也能导入');
  const listPage = [
    '<html><body><table id="sycjlrtabGrid" class="table_tb">',
    '<thead><tr><td>课程名称</td><td>上课时间地点</td><td>项目名称</td><td>周次</td></tr></thead>',
    '<tbody>',
    '<tr><td>中国近现代史纲要</td><td>星期一第1-2节</td><td>何伟</td><td>1-16周</td></tr>',
    '<tr><td>马克思主义基本原理</td><td>星期四第3-4节</td><td>郑霞</td><td>1-16周</td></tr>',
    '<tr><td>大学物理</td><td>星期五第5-6节</td><td>吴敏</td><td>1-8,10-16周</td></tr>',
    '</tbody></table></body></html>'
  ].join('');
  await evalJs(asFile(listPage, 'xskbcx_cxXskbcxList.html'));
  await wait(600);
  const listPreview = await evalJs('document.getElementById("importResult").innerText');
  check('列表式课表识别到 3 门课', /3\s*门课程/.test(listPreview), listPreview.slice(0, 90));
  check('提示里说明用的是「课程列表」变体', /课程列表/.test(listPreview));

  /* v1.8.1：真机截图那一页 —— 正方「课表列表」视图。
     表头是「星期 / 节次 / 课表信息」，节次列只写「1-2」，
     每个值都带「字段名：」外壳，地点写成「明理（5）-401」。
     直接在页面里调 EduGrab 拿结构化的课程，逐字段核对。 */
  console.log('\n[7] 真机现场页：星期 / 节次 / 课表信息（正方列表视图）');
  const realPage = [
    '<html><body><div class="list-top">2026-2027学年第1学期</div>',
    '<table id="sycjlrtabGrid" class="table_tb">',
    '<thead><tr><th>星期</th><th>节次</th><th>课表信息</th></tr></thead>',
    '<tbody>',
    '<tr><td>星期一</td><td>1-2</td><td>',
    '<div><font>Linux系统管理★</font></div>',
    '<div>周数：2-16周(双)</div>',
    '<div>校区:北校区校区(南区)</div>',
    '<div>上课地点：明理（5）-401</div>',
    '<div>教师：李明</div>',
    '<div>教学班：Linux系统管理1班</div>',
    '</td></tr>',
    '<tr><td>星期二</td><td>3-4</td><td>',
    '<div>数据库原理及应用★</div>',
    '<div>周数：1-16周</div>',
    '<div>校区:北校区校区(南区)</div>',
    '<div>上课地点：明理（5）-302</div>',
    '<div>教师：李伟</div>',
    '<div>教学班：数据库原理及应用1班</div>',
    '</td></tr>',
    '</tbody></table></body></html>'
  ].join('');
  await evalJs(asFile(realPage, 'xskbcx_cxXskbcxList.html'));
  await wait(600);
  const realPreview = await evalJs('document.getElementById("importResult").innerText');
  check('真机现场页识别到 2 门课', /2\s*门课程/.test(realPreview), realPreview.slice(0, 90));
  check('真机现场页没有解析警告', !/警告：/.test(realPreview), realPreview.slice(0, 160));

  const realCourses = JSON.parse(await evalJs(
    'JSON.stringify(window.EduGrab.extract(' + JSON.stringify(realPage) +
    ',{totalWeeks:18}).courses)'
  ));
  check('  课程数 = 2', realCourses.length === 2, realCourses.length);
  const rl = realCourses.filter(function (c) { return /Linux系统管理/.test(c.name); })[0];
  check('  Linux系统管理★ = 周一 1-2 节（节次列只写「1-2」，没有「节」字）',
    !!rl && rl.day === 1 && rl.start === 1 && rl.end === 2,
    rl ? rl.day + ' / ' + rl.start + '-' + rl.end : 'missing');
  check('  教师剥掉「教师：」外壳', !!rl && rl.teacher === '李明', rl ? rl.teacher : 'missing');
  check('  地点认得出「明理（5）-401」',
    !!rl && rl.location === '明理（5）-401', rl ? rl.location : 'missing');
  check('  「周数：2-16周(双)」的单双周没丢（8 个偶数周）',
    !!rl && rl.weeks.length === 8 && rl.weeks.every(function (w) { return w % 2 === 0; }),
    rl ? rl.weeks.join(',') : 'missing');
  const rb = realCourses.filter(function (c) { return /数据库原理/.test(c.name); })[0];
  check('  数据库原理及应用★ = 周二 3-4 节 + 明理（5）-302',
    !!rb && rb.day === 2 && rb.start === 3 && rb.end === 4 && rb.location === '明理（5）-302',
    JSON.stringify(rb));

  /* v1.9.36：本校**不做特例**。地址簿（最近使用 / 我的学校）是纯用户数据，
     本校只经 localLibrary() 挂进适配库字母列表，与其他学校同一待遇；
     主按钮跟 v1.9.34 一样跟着用户的使用记录走，没用过就是引导语。
     网页版里没有原生桥，把 window.AndroidEdu 换成探针，
     验证「点一下 -> 交给原生打开的是哪一条地址」这一跳是否真的对。 */
  console.log('\n[8] 打开教务系统：地址簿纯用户数据，本校与其他学校同列（v1.9.36）');
  const DEMO_URL = 'https://jwgl.example.edu.cn/jwglxt/xtgl/login_slogin.html';
  await evalJs('window.__opened=[];' +
    'window.AndroidEdu={open:function(u){window.__opened.push(u);}};1');
  await evalJs('window.Schools.clearAll();window.Schools.reload();window.Schools.clearRecent();1');
  /* 本校的名字与地址**从页面里现取**（判据不写死校名，形状与一致性才作数） */
  const LOCAL_NAME = await evalJs('window.Schools.localLibrary()[0].name');
  const LOCAL_URL = await evalJs('window.Schools.localLibrary()[0].adapters[0].importUrl');

  /* 喂一份**合成索引**（桥用桩替，页面逻辑是真的）——
     否则 file:// 环境没有 AndroidWarehouse，字母列表渲染不出来，
     「本校排在字母列表里」就没法在 UI 层验证。
     v1.9.41 起包里不再有内置快照，所以这里也换成了**真实那条路**：
     桩 `AndroidWarehouse.getBinary`（运行时下载），数据用
     tools/index-fixture.js 的合成索引 —— 不再依赖任何包内资产。 */
  const IDX_B64 = Buffer.from(
    require(path.join(root, 'tools', 'index-fixture.js')).buildSampleIndex()
  ).toString('base64');
  await evalJs('window.AndroidWarehouse={getBinary:function(u,id){' +
    'setTimeout(function(){window.WarehouseHost.onBinary(id,"ok:' + IDX_B64 + '");},30);}};1');
  await evalJs('window.Warehouse.update().then(function(){window.__whOk=1;},function(){});1');
  let whOk = false;
  for (let i = 0; i < 50 && !whOk; i++) {
    whOk = (await evalJs('!!window.__whOk && window.Warehouse.loaded()'));
    if (!whOk) await wait(100);
  }
  check('合成索引载入成功（字母列表的数据源就位）', whOk);
  check('本校已在适配库数据里（setLocalSchools 注册链在 e2e 里也成立）',
    (await evalJs('window.Warehouse.schools()')).some(function (s) { return s.name === LOCAL_NAME; }));

  /* 一所学校都没用过：主按钮是 v1.9.34 的引导语，点了不去打开空地址 */
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(300);
  check('导入弹层已打开',
    await evalJs('document.getElementById("maskImport").classList.contains("show")'));
  check('没用过任何学校时，主按钮是引导语（本校不再写死在按钮上）',
    (await evalJs('document.getElementById("eduEntryLabel").textContent')) ===
      '打开我的学校教务系统',
    await evalJs('document.getElementById("eduEntryLabel").textContent'));
  await evalJs('document.getElementById("btnEduEntry").click();1');
  await wait(400);
  check('没有使用记录时不去打开空地址（原生一次都没被调）',
    await evalJs('window.__opened.length') === 0,
    await evalJs('String(window.__opened.length)'));
  check('而是把「打开教务系统」页推出来，引导用户先选一次学校',
    await evalJs('document.getElementById("maskSchool").classList.contains("show")'));
  check('导入弹层已收起，两层不叠在一起',
    !(await evalJs('document.getElementById("maskImport").classList.contains("show")')));

  const listText = await evalJs('document.getElementById("schoolList").innerText');
  check('没有「本校（点一下即打开）」特例组（v1.9.36 拆除）',
    !/本校（点一下即打开）/.test(listText), listText.slice(0, 60));
  check('自建为空时的空态给出「手动输入 / 批量导入」引导',
    /还没有添加学校/.test(listText) && /手动输入/.test(listText),
    listText.slice(0, 80));
  check('省份筛选块已移除',
    await evalJs('document.getElementById("schoolProvs")') === null);

  /* 本校跟其他学校排一块：出现在适配库字母列表里，带与其他学校相同的行结构 */
  const libRows = await evalJs('(function(){' +
    'var rows=[].slice.call(document.querySelectorAll("#schoolList [data-lib]"));' +
    'return JSON.stringify(rows.map(function(r){' +
    'var t=r.querySelector(".sr-name .txt");' +
    'return {name:t?t.textContent:"",lib:r.getAttribute("data-lib")};}));})();');
  const libParsed = JSON.parse(libRows);
  const localRow = libParsed.filter(function (r) { return r.name === LOCAL_NAME; });
  check('本校出现在适配库列表里（与社区学校同一行结构 data-lib）',
    localRow.length >= 1 && !!localRow[0].lib,
    libRows.slice(0, 120));
  check('字母列表里确实有本校的首字母分组（与社区学校混排，不是独立一组）',
    listText.indexOf(LOCAL_NAME) >= 0 && !/本校/.test(listText),
    listText.slice(0, 100));

  await shot(path.join(outDir, '图17-打开教务系统-v1.9.36.png'));

  /* 搜不到时不能是一片空白，要给出「手动输入 / 批量导入」的出口 */
  await evalJs('(function(){var i=document.getElementById("schoolSearch");' +
    'i.value="查无此校zzz";i.dispatchEvent(new Event("input"));})();1');
  await wait(300);
  const empty = await evalJs('document.getElementById("schoolList").innerText');
  check('搜不到时给出指引而不是空白',
    /没找到这个学校/.test(empty) && /手动输入/.test(empty), empty.slice(0, 50));

  /* 加一所自建学校：主按钮写它的名字（跟 v1.9.34 一样跟着使用记录走） */
  await evalJs('window.Schools.addCustom("示例大学",' + JSON.stringify(DEMO_URL) + ');1');
  await evalJs('document.getElementById("btnSchoolClose").click();1');
  await wait(200);
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(300);
  check('自建学校加入后，主按钮写自建校名（不再被内置本校占住）',
    await evalJs('document.getElementById("eduEntryLabel").textContent') ===
      '打开示例大学教务系统',
    await evalJs('document.getElementById("eduEntryLabel").textContent'));
  await evalJs('document.getElementById("btnEduEntry").click();1');
  await wait(350);
  check('一键直达把该校教务地址交给了原生浏览器',
    await evalJs('window.__opened[window.__opened.length-1]') === DEMO_URL,
    await evalJs('String(window.__opened[window.__opened.length-1])'));
  check('一键直达后导入弹层自动收起',
    !(await evalJs('document.getElementById("maskImport").classList.contains("show")')));
  check('这次打开被记进了「最近使用」',
    await evalJs('window.Schools.recent()[0].url') === DEMO_URL);

  /* 列表里点**自建学校那一行**：地址原样交给原生浏览器（不匹配任何内置适配） */
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(250);
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(300);
  const n0 = await evalJs('window.__opened.length');
  await evalJs('(function(){var r=document.querySelector(' +
      '\'#schoolList [data-name="示例大学"]\');r.click();})();1');
  await wait(300);
  check('列表里点自建学校那一行，地址交给原生浏览器',
    (await evalJs('window.__opened.length')) === n0 + 1 &&
    (await evalJs('window.__opened[window.__opened.length-1]')) === DEMO_URL,
    await evalJs('String(window.__opened[window.__opened.length-1])'));
  check('点开后弹层自动收起',
    !(await evalJs('document.getElementById("maskSchool").classList.contains("show")')));

  /* 手动输入：只填域名 -> 补全 -> 保存并打开 */
  console.log('\n[9] 手动输入学校：域名自动补全');
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(250);
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(300);
  await evalJs('document.getElementById("btnSchManualToggle").click();1');
  await wait(250);
  check('「手动输入」面板展开',
    !(await evalJs('document.getElementById("schoolManual").hidden')));
  await evalJs('(function(){var i=document.getElementById("schUrl");' +
    'i.value="jwgl.demo.edu.cn";i.dispatchEvent(new Event("input"));})();1');
  await wait(250);
  check('只填域名时提示可以一步补全',
    /只填了域名/.test(await evalJs('document.getElementById("schUrlHint").innerText')));
  await shot(path.join(outDir, '图18-手动填学校-v1.8.4.png'));

  await evalJs('document.getElementById("btnSchZf").click();1');
  await wait(250);
  const filled = await evalJs('document.getElementById("schUrl").value');
  check('按正方规则补全出标准登录页',
    filled === 'https://jwgl.demo.edu.cn/jwglxt/xtgl/login_slogin.html', filled);

  const before = await evalJs('window.__opened.length');
  await evalJs('(function(){var n=document.getElementById("schName");n.value="演示大学";})();1');
  await evalJs('document.getElementById("btnSchSave").click();1');
  await wait(350);
  check('保存后立即用该地址打开',
    await evalJs('window.__opened[window.__opened.length-1]') === filled);
  check('打开次数确实 +1',
    await evalJs('window.__opened.length') === before + 1);
  check('保存的学校进了「我的学校」',
    await evalJs('window.Schools.customList()[0].name') === '演示大学');

  /* 非法地址要拦住——「把学校名填进地址栏」是最常见的错 */
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(300);
  await evalJs('document.getElementById("btnSchManualToggle").click();1');
  await wait(200);
  await evalJs('(function(){var n=document.getElementById("schName");n.value="没域名大学";' +
    'var u=document.getElementById("schUrl");u.value="随便写点什么";})();1');
  const errCount = await evalJs('window.__opened.length');
  await evalJs('document.getElementById("btnSchSave").click();1');
  await wait(300);
  const err = await evalJs('document.getElementById("schoolResult").innerText');
  check('地址里没有域名时被拦住并说明原因',
    /没有识别到有效的域名/.test(err), err.slice(0, 60));
  check('被拦住时不会误打开浏览器',
    await evalJs('window.__opened.length') === errCount);

  /* 删除：按钮长在行里，点删除不能连带把浏览器打开 */
  console.log('\n[10] 我的学校：删除按钮不误触发打开');
  const before10 = JSON.parse(await evalJs(
    'JSON.stringify(window.Schools.customList().map(function(s){return s.name}))'));
  const delOpened = await evalJs('window.__opened.length');
  const delId = await evalJs(
    '(function(){var b=document.querySelector("#schoolList [data-del]");' +
    'if(!b)return "";b.click();return b.getAttribute("data-del");})()'
  );
  check('行里有删除按钮', !!delId, delId);
  await wait(300);
  const after10 = JSON.parse(await evalJs(
    'JSON.stringify(window.Schools.customList().map(function(s){return s.name}))'));
  check('删除后那一所从「我的学校」里消失了（只少它一个）',
    after10.length === before10.length - 1 && after10.indexOf('演示大学') < 0,
    JSON.stringify(before10) + ' -> ' + JSON.stringify(after10));
  check('点删除没有连带打开浏览器',
    await evalJs('window.__opened.length') === delOpened);

  /* 批量导入：一次加一批，且要能识别「已经在列表里的」 */
  console.log('\n[11] 批量导入学校列表');
  await evalJs('document.getElementById("btnSchImportToggle").click();1');
  await wait(250);
  check('「批量导入」面板展开',
    !(await evalJs('document.getElementById("schoolImport").hidden')));
  const before11 = await evalJs('window.Schools.customList().length');
  const batch = [
    '演示大学B,示例省,http://jwgl.demob.edu.cn/jwglxt/',
    '示例大学,https://jwgl.example.edu.cn/jwglxt/xtgl/login_slogin.html',
    '瞎写的一行没有地址'
  ].join('\n');
  await evalJs('document.getElementById("schImportArea").value=' + JSON.stringify(batch) + ';1');
  await evalJs('document.getElementById("btnSchImportDo").click();1');
  await wait(350);
  const impMsg = await evalJs('document.getElementById("schoolResult").innerText');
  check('报告新增 1 所、跳过 2 条（已在列表里的 + 看不懂的）',
    /新增 1 所/.test(impMsg) && /跳过/.test(impMsg), impMsg.replace(/\n/g, ' ').slice(0, 90));
  check('导入的学校真的进了「我的学校」',
    await evalJs('window.Schools.customList().length') === before11 + 1,
    await evalJs('String(window.Schools.customList().length)'));
  check('已在列表里的那条没有被重复添加',
    await evalJs('window.Schools.customList().filter(function(s){' +
      'return s.name === "示例大学"}).length') === 1);

  await evalJs('document.getElementById("btnSchExport").click();1');
  await wait(300);
  const exported = await evalJs('document.getElementById("schImportArea").value');
  check('导出把「我的学校」填回框里，可直接复制备份',
    /演示大学B/.test(exported) && /demob/.test(exported), exported.slice(0, 80));

  /* ============================================================
     [13] 课程详情：拖拽关闭 / 编辑 / 复制
     ------------------------------------------------------------
     拖拽是唯一「光看代码看不出对不对」的东西，所以这里用真实的
     鼠标按下 -> 移动 -> 松开 去驱动，而不是直接调内部函数。
     ============================================================ */
  console.log('\n[13] 课程详情：拖拽关闭 + 编辑 / 复制');

  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
    type: type, x: x, y: y, button: 'left', clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : 1
  });
  /** 从 (x,y) 向下拖 dy 像素；分步移动，速度才有意义 */
  const dragDown = async (x, y, dy, steps) => {
    await mouse('mousePressed', x, y);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x, y + Math.round(dy * i / steps));
      await wait(16);
    }
    await mouse('mouseReleased', x, y + dy);
  };
  /* 真机走的是触摸事件，和鼠标是两条独立分支（touchmove 里要 preventDefault
     才拦得住原生滚动），所以必须单独验一遍。 */
  const touch = (type, x, y) => send('Input.dispatchTouchEvent', {
    type: type, touchPoints: type === 'touchEnd' ? [] : [{ x: x, y: y }]
  });
  const touchDragDown = async (x, y, dy, steps) => {
    await touch('touchStart', x, y);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x, y + Math.round(dy * i / steps));
      await wait(16);
    }
    await touch('touchEnd', x, y + dy);
  };
  const detailOpen = () => evalJs('document.getElementById("maskDetail").classList.contains("show")');
  const copyOpen = () => evalJs('document.getElementById("maskCopy").classList.contains("show")');
  /** 详情弹层的位置（拖拽要落在它身上） */
  const sheetBox = () => evalJs(
    'JSON.stringify((function(){var s=document.querySelector("#maskDetail .sheet");' +
    'if(!s)return null;var r=s.getBoundingClientRect();' +
    'return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+18),h:Math.round(r.height)};})())'
  );

  /* 从干净状态出发：清空课表，再用真实 UI 加一门课。
     清场刻意用遍历而不是列一份 id 名单——测试里那份名单和产品代码里
     曾经那份一样，加一层新弹层就会漏（v1.8.3 的返回键就是这么坏掉的）。 */
  await evalJs('(function(){' +
    '[].slice.call(document.querySelectorAll(".mask.show"))' +
    '.forEach(function(el){el.classList.remove("show");});})();1');
  await wait(150);
  await evalJs('(function(){window.ScheduleApp.state.courses=[];' +
    'window.ScheduleApp.state.viewWeek=1;Store.save();window.ScheduleApp.render();})();1');
  await wait(200);
  await evalJs('document.getElementById("btnAdd").click();1');
  await wait(250);
  await evalJs('(function(){' +
    'document.getElementById("addName").value="高等数学";' +
    'document.getElementById("addDay").value="1";' +
    'document.getElementById("addStart").value="1";' +
    'document.getElementById("addEnd").value="2";' +
    'document.getElementById("addTeacher").value="李明";' +
    'document.getElementById("addLocation").value="明理（5）-401";' +
    'document.getElementById("addWeeks").value="1-16";' +
    '})();1');
  await evalJs('document.getElementById("btnAddSave").click();1');
  await wait(400);
  check('用「＋」添加了一门课', await evalJs('window.ScheduleApp.state.courses.length') === 1);

  /* ---- 详情弹层：结构 ---- */
  await evalJs('document.querySelector(".course").click();1');
  await wait(300);
  check('点击课程弹出详情', await detailOpen());
  check('详情里没有「关闭」按钮（改由拖拽 / 点外部关闭）',
    await evalJs('!!document.getElementById("btnDetailClose")') === false);
  check('底部是 编辑 / 复制 / 删除',
    await evalJs('["btnDetailEdit","btnDetailCopy","btnDetailDelete"]' +
      '.every(function(i){return !!document.getElementById(i)})'));
  await wait(1700);          // 等上一步的 toast 淡掉，别让它压住按钮
  await shot(path.join(outDir, '图20-课程详情-v1.9.1.png'));

  /* ---- 关闭方式一：点弹层外的空白处 ---- */
  await mouse('mousePressed', 195, 60);
  await mouse('mouseReleased', 195, 60);
  await wait(350);
  check('点弹层外的空白处即关闭', !(await detailOpen()));

  /* ---- 关闭方式二：向下拖拽 ---- */
  await evalJs('document.querySelector(".course").click();1');
  await wait(300);
  let box = JSON.parse(await sheetBox());
  check('拿到详情弹层位置', !!box && box.h > 100, JSON.stringify(box));

  // 先试「拖不够」：位移很小、慢慢拖 -> 应当回弹而不是关掉
  await dragDown(box.x, box.y, 20, 5);
  await wait(500);
  check('拖得不够时回弹，弹层不关', await detailOpen());
  check('回弹后位移被清干净',
    await evalJs('document.querySelector("#maskDetail .sheet").style.transform') === '');

  // 再试「拖够」：一次长拖 -> 关闭
  box = JSON.parse(await sheetBox());
  await dragDown(box.x, box.y, 260, 5);
  await wait(600);
  check('向下拖拽可以关闭详情弹层', !(await detailOpen()));
  check('拖拽没有连带把课表上的卡片又点开',
    !(await detailOpen()) && await evalJs('window.ScheduleApp.state.courses.length') === 1);

  /* ---- 真机路径：触摸事件（不是鼠标）也能拖走 ---- */
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await evalJs('document.querySelector(".course").click();1');
  await wait(300);
  box = JSON.parse(await sheetBox());
  await touchDragDown(box.x, box.y, 260, 5);
  await wait(600);
  check('触摸拖拽（真机路径）同样能关闭', !(await detailOpen()));
  // 触摸拖拽同样不能漏掉那个补发的 click
  check('触摸拖拽后没有又弹出一份详情', !(await detailOpen()));
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  /* ---- 编辑：改课程名 + 换一天，保存后课表要跟着变 ---- */
  await evalJs('document.querySelector(".course").click();1');
  await wait(300);
  await evalJs('document.getElementById("btnDetailEdit").click();1');
  await wait(300);
  check('点「编辑」后详情收起、表单打开',
    !(await detailOpen()) &&
    await evalJs('document.getElementById("maskAdd").classList.contains("show")'));
  check('标题变成「编辑课程」',
    await evalJs('document.getElementById("addTitle").innerText') === '编辑课程');
  check('按钮变成「保存修改」',
    await evalJs('document.getElementById("btnAddSave").innerText') === '保存修改');
  check('字段预填了原课程信息',
    await evalJs('document.getElementById("addName").value') === '高等数学' &&
    await evalJs('document.getElementById("addTeacher").value') === '李明' &&
    await evalJs('document.getElementById("addLocation").value') === '明理（5）-401' &&
    await evalJs('document.getElementById("addWeeks").value') === '1-16');
  await shot(path.join(outDir, '图21-编辑课程-v1.9.1.png'));

  await evalJs('(function(){document.getElementById("addName").value="高等数学（改）";' +
    'document.getElementById("addDay").value="3";})();1');
  await evalJs('document.getElementById("btnAddSave").click();1');
  await wait(450);
  check('改动落到了课表上', await evalJs('window.ScheduleApp.state.courses[0].name') === '高等数学（改）',
    await evalJs('window.ScheduleApp.state.courses[0].name'));
  check('换天也生效（周三）', await evalJs('window.ScheduleApp.state.courses[0].day') === 3);
  check('是就地改这门课，没有多出一门',
    await evalJs('window.ScheduleApp.state.courses.length') === 1);
  check('卡片上的课名跟着更新',
    /高等数学（改）/.test(await evalJs('document.getElementById("schedule").innerText')));
  check('编辑完回到添加模式（标题复位）',
    await evalJs('document.getElementById("addTitle").innerText') === '添加课程');

  /* ---- 复制：两个选项各拿什么 ---- */
  // 用一个假的剪贴板桥接住内容（真机上这里是原生 AndroidClipboard）
  await evalJs('window.__clip=null;window.AndroidClipboard={copy:function(t){window.__clip=t;}};1');
  await evalJs('document.querySelector(".course").click();1');
  await wait(300);
  await evalJs('document.getElementById("btnDetailCopy").click();1');
  await wait(300);
  check('点「复制」弹出两个选项，且详情先收起（弹层不叠）',
    (await copyOpen()) && !(await detailOpen()));
  check('两个选项是「复制完整课程 / 复制课程名称」',
    await evalJs('document.getElementById("btnCopyFull").innerText').then((t) => /复制完整课程/.test(t)) &&
    await evalJs('document.getElementById("btnCopyName").innerText').then((t) => /复制课程名称/.test(t)));
  await wait(1000);          // 等「已保存修改」的 toast 淡掉再截图
  await shot(path.join(outDir, '图22-复制课程-v1.9.1.png'));

  await evalJs('document.getElementById("btnCopyFull").click();1');
  await wait(300);
  const full = await evalJs('window.__clip');
  console.log('  ── 完整课程文本 ──\n' + String(full).split('\n').map((l) => '  | ' + l).join('\n'));
  check('完整课程带上了课名与各项信息',
    /^高等数学（改）/.test(String(full)) && /时间：星期三/.test(String(full)) &&
    /第 1-2 节/.test(String(full)) && /地点：明理（5）-401/.test(String(full)) &&
    /教师：李明/.test(String(full)) && /周次：1-16/.test(String(full)), String(full).replace(/\n/g, ' / '));
  check('复制完回到课程详情', (await detailOpen()) && !(await copyOpen()));

  await evalJs('document.getElementById("btnDetailCopy").click();1');
  await wait(250);
  await evalJs('document.getElementById("btnCopyName").click();1');
  await wait(250);
  check('「复制课程名称」只复制课名', await evalJs('window.__clip') === '高等数学（改）');

  await evalJs('document.getElementById("btnDetailCopy").click();1');
  await wait(250);
  await evalJs('document.getElementById("btnCopyCancel").click();1');
  await wait(250);
  check('取消复制也回到课程详情', (await detailOpen()) && !(await copyOpen()));

  /* ---- 弹层退出路径：子弹层退回父层，且不再依赖手写名单 ----
     回归的是 v1.8.3 埋下的缺口：「选择学校」层没被写进关闭名单，
     结果是它的返回键与「点弹层外」双双失效——而且返回键是被原生
     当成「已消费」吞掉的，按下去毫无反应。 */
  console.log('  ── 弹层退出路径（原「选择学校」层返回键 / 点外部都关不掉）──');
  const importOpen = () => evalJs('document.getElementById("maskImport").classList.contains("show")');
  const schoolOpen = () => evalJs('document.getElementById("maskSchool").classList.contains("show")');
  const openCount = () => evalJs('document.querySelectorAll(".mask.show").length');

  /* 从干净状态出发。上一步「取消复制」会回到课程详情，而详情是覆盖全屏的，
     真实操作里根本点不到底下的「导入课表」——直接 .click() 会绕过这层遮挡
     （openMask 本身不做互斥，靠调用方自己先 closeMask，见项目约定）。
     叠着测的话，截图看不出「退回导入」到底退没退成。 */
  await evalJs('window.closeAllMasks();1');
  await wait(200);
  check('清场：此刻没有任何弹层', (await openCount()) === 0);

  await evalJs('document.getElementById("btnImport").click();1');
  await wait(250);
  check('「打开教务系统」在导入弹层里', await importOpen());
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(250);
  check('子弹层打开时父层先收起（弹层不叠）', (await schoolOpen()) && !(await importOpen()));

  const back1 = await evalJs('window.handleBack()');
  await wait(250);
  check('返回键：从「选择学校」退回「导入课表」（不是一把掀回课表）',
    back1 === true && (await importOpen()) && !(await schoolOpen()),
    'handleBack=' + back1);
  await wait(1000);          // 等 toast 淡掉再截图
  await shot(path.join(outDir, '图23-返回键退回导入-v1.9.2.png'));

  const back2 = await evalJs('window.handleBack()');
  await wait(250);
  check('再按一次返回：这一层也关掉', back2 === true && !(await importOpen()));
  check('没有弹层时返回 false（交给原生 goBack / 退出）',
    (await evalJs('window.handleBack()')) === false);

  /* 点弹层外：同一层的三个出口行为必须一致，否则「按按钮退到 A、按返回退到 B」 */
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(200);
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(250);
  await evalJs('document.getElementById("maskSchool")' +
    '.dispatchEvent(new MouseEvent("click",{bubbles:true}));1');
  await wait(250);
  check('点弹层外：同样退回「导入课表」', (await importOpen()) && !(await schoolOpen()));

  /* 全关兜底：改成遍历之后，这一层不会再被漏掉 */
  await evalJs('document.getElementById("btnEduImport").click();1');
  await wait(200);
  check('此刻确实只有「选择学校」一层开着',
    (await schoolOpen()) && (await openCount()) === 1, 'open=' + (await openCount()));
  await evalJs('window.closeAllMasks();1');
  await wait(200);
  check('closeAllMasks 覆盖到「选择学校」层（原来就是这里漏的）',
    (await openCount()) === 0, '剩下 ' + (await openCount()) + ' 层');

  console.log('\n[14] 编辑时间表：设置里只剩一个入口，改完保存回写课表');
  const ttOpen = () => evalJs('document.getElementById("maskTimetable").classList.contains("show")');
  const settingsOpen = () => evalJs('document.getElementById("maskSettings").classList.contains("show")');
  const ttCount = () => evalJs('document.querySelectorAll("#ttList .tt-row").length');
  /* 不提属性选择器：`[data-i='0']` 在生成 JS 字符串时得再套一层引号转义，
     绕开它直接按行取两个 input，读起来也更直白。 */
  const ttVal = (i, k) => evalJs(
    '(function(){var r=document.querySelectorAll("#ttList .tt-row")[' + i + '];' +
    'if(!r)return null;return r.querySelectorAll(".tp")[' + (k === 'start' ? 0 : 1) + '].value;})()');
  const ttSet = (i, k, v) => evalJs(
    '(function(){var r=document.querySelectorAll("#ttList .tt-row")[' + i + '];' +
    'var el=r.querySelectorAll(".tp")[' + (k === 'start' ? 0 : 1) + '];el.value=' + JSON.stringify(v) +
    ';el.dispatchEvent(new Event("change",{bubbles:true}));})();1');
  const ttAllEndDisabled = () => evalJs(
    '[].slice.call(document.querySelectorAll("#ttList [data-k=end]"))' +
    '.every(function(i){return i.disabled})');
  const addMin = (hhmm, d) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    const v = h * 60 + m + d;
    return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
  };
  /* 自绘单选列表里「当前值那一行」与列表可视区的关系。选中的那一行是整个选择器最
     重要的一行，必须**完整**看得见——被容器边缘切掉半行的话，用户得先滑一下才知道
     自己选的是哪个。位置类断言比的是「行相对列表的坐标」，不是任意两个数之差。 */
  const pickRowFit = (box) => evalJs(
    '(function(){var b=document.getElementById(' + JSON.stringify(box) + ');' +
    'if(!b)return null;var on=b.querySelector(".pick-row.is-on");if(!on)return null;' +
    'var br=b.getBoundingClientRect(),r=on.getBoundingClientRect();' +
    'return {topOK:r.top>=br.top-0.5,botOK:r.bottom<=br.bottom+0.5,' +
    'rowTop:+(r.top-br.top).toFixed(1),boxH:Math.round(br.height),' +
    'label:on.querySelector(".pk-t").textContent};})()');
  const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

  /* 初值一律从运行时读。
     前面几段真的导入过课表、可能已经把「每天节数」抬到 13/14，
     把 12、08:00 这种数字写死在断言里，早晚会假绿或假红。 */
  const sec0 = await evalJs('window.ScheduleApp.state.settings.sections');
  const storedTimes = JSON.parse(
    await evalJs('JSON.stringify(window.ScheduleApp.state.settings.times)'));
  const lastIdx = sec0 - 1;

  await evalJs('window.closeAllMasks();1');
  await wait(200);
  check('清场：此刻没有任何弹层', (await openCount()) === 0);

  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(300);
  check('设置里「上课时间表」是一个跳转行，不再有手打的文本框',
    (await evalJs('!!document.getElementById("btnTimes")')) &&
    !(await evalJs('!!document.getElementById("setTimes")')));
  const sum0 = String(await evalJs('document.getElementById("timesSummary").textContent'));
  check('入口行给出摘要（共 N 节 · 第 1 节几点起）',
    sum0.indexOf('共 ' + sec0 + ' 节 · 第 1 节 ' + storedTimes[0].start + ' 起') === 0, sum0);
  await wait(1000);          // 等上一步的 toast 淡掉再截图
  await shot(path.join(outDir, '图24-设置里的时间表入口-v1.9.3.png'));

  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(350);
  check('点进编辑时间表：整页出现，设置那一层先收起（弹层不叠）',
    (await ttOpen()) && !(await settingsOpen()));
  check('每一节一行，行数 = 每天节数', (await ttCount()) === sec0, String(await ttCount()));
  check('每行两个时间输入框', (await evalJs(
    'document.querySelectorAll("#ttList .tp").length')) === sec0 * 2);
  check('固定上课时长默认开着，结束时间不给改（是算出来的）',
    (await evalJs('document.getElementById("ttFixed").checked')) === true &&
    (await ttAllEndDisabled()) === true);

  /* ---- 改第 1 节开始时间：后面所有节整体平移 ---- */
  const r0s = await ttVal(0, 'start');
  const r1s = await ttVal(1, 'start');
  const r2e = await ttVal(2, 'end');
  const r3s = await ttVal(3, 'start');
  const rls = await ttVal(lastIdx, 'start');
  const gap23 = toMin(r3s) - toMin(r2e);

  await ttSet(0, 'start', addMin(r0s, 20));
  await wait(250);
  check('改第 1 节 -> 第 1 节自己落到新时间', (await ttVal(0, 'start')) === addMin(r0s, 20),
    String(await ttVal(0, 'start')));
  check('第 2 节整体后移同样 20 分钟', (await ttVal(1, 'start')) === addMin(r1s, 20),
    String(await ttVal(1, 'start')));
  check('最后一节也跟着挪了（不是只挪相邻那一节）',
    (await ttVal(lastIdx, 'start')) === addMin(rls, 20), String(await ttVal(lastIdx, 'start')));

  /* ---- 夹取：不能改到上一节还没下课 ---- */
  await ttSet(2, 'start', '00:00');
  await wait(250);
  check('改到上一节还没下课：顶在上一节结束那一刻，并回写到输入框',
    (await ttVal(2, 'start')) === (await ttVal(1, 'end')),
    (await ttVal(1, 'end')) + ' vs ' + (await ttVal(2, 'start')));
  check('被夹之后，后面几节的课间间隔保持不变',
    toMin(await ttVal(3, 'start')) - toMin(await ttVal(2, 'end')) === gap23,
    String(toMin(await ttVal(3, 'start')) - toMin(await ttVal(2, 'end'))) + ' vs ' + gap23);

  /* ---- 关掉固定时长：结束时间变成可改，时长那一项灰掉 ---- */
  await evalJs('(function(){var c=document.getElementById("ttFixed");c.checked=false;' +
    'c.dispatchEvent(new Event("change",{bubbles:true}));})();1');
  await wait(200);
  check('关掉固定时长后，结束时间可以单独改', (await ttAllEndDisabled()) === false);
  check('关掉固定时长后「每节时长」灰掉（那一项当时不归你用）',
    (await evalJs('document.getElementById("ttDur").disabled')) === true &&
    (await evalJs('document.getElementById("rowDur").classList.contains("off")')) === true);

  /* ---- 重新打开固定时长 + 改时长：只重算结束时间 ----
     v1.9.15：「每节课时长」不再是原生 <select>（它弹的系统列表够不着主题），
     改成自绘单选列表。所以这里不能像以前那样直接 .value= + change ——
     必须真点开弹层、真点那一行，否则「点了没反应」这类问题测试根本看不见。 */
  await evalJs('(function(){var c=document.getElementById("ttFixed");c.checked=true;' +
    'c.dispatchEvent(new Event("change",{bubbles:true}));})();1');
  await wait(200);
  const startBeforeDur = await ttVal(0, 'start');
  const durBefore = String(await evalJs('document.getElementById("ttDur").value'));
  await evalJs('document.getElementById("ttDur").click();1');
  await wait(320);
  const durPick = JSON.parse(await evalJs('JSON.stringify((function(){' +
    'var r=document.querySelectorAll("#pickList .pick-row"),on=null;' +
    'for(var i=0;i<r.length;i++){if(r[i].classList.contains("is-on"))on=r[i];}' +
    'return {open:document.getElementById("maskPick").classList.contains("show"),' +
    'ttOpen:document.getElementById("maskTimetable").classList.contains("show"),' +
    'title:document.getElementById("pickTitle").textContent,n:r.length,' +
    'on:on?on.getAttribute("data-v"):null};})())'));
  check('点「每节课时长」弹出的是自绘单选列表，当前值那行被标出来（弹层不许叠）',
    durPick.open && !durPick.ttOpen && durPick.title === '每节课时长' &&
    durPick.on === durBefore && durPick.n >= 13, JSON.stringify(durPick));
  const durFit = await pickRowFit('pickList');
  check('当前值那一行完整落在列表可视区内（不用先滑一下才看得见选的是哪个）',
    durFit && durFit.topOK && durFit.botOK, JSON.stringify(durFit));
  await shot(path.join(outDir, '图38-每节时长选择-v1.9.15.png'));
  await evalJs('(function(){var r=document.querySelectorAll("#pickList .pick-row");' +
    'for(var i=0;i<r.length;i++){if(r[i].getAttribute("data-v")==="50"){r[i].click();return;}}})();1');
  await wait(320);
  check('点一下即生效并退回编辑时间表（省掉一次「确定」）',
    (await evalJs('document.getElementById("maskPick").classList.contains("show")')) === false &&
    (await ttOpen()) === true);
  check('那一行显示的文字也跟着变成 50 分钟（不是只有值变了）',
    (await evalJs('document.getElementById("ttDurText").textContent')) === '50 分钟');
  check('改「每节课时长」为 50 分钟：结束时间重算，开始时间一点没动',
    (await ttVal(0, 'end')) === addMin(startBeforeDur, 50) &&
    (await ttVal(0, 'start')) === startBeforeDur,
    (await ttVal(0, 'start')) + '-' + (await ttVal(0, 'end')));
  await wait(1000);          // 等 toast 淡掉再截图
  await shot(path.join(outDir, '图25-编辑时间表-v1.9.3.png'));

  /* ---- 保存：写回当前课表 ---- */
  await evalJs('document.getElementById("ttSave").click();1');
  await wait(400);
  const saved0 = await evalJs('JSON.stringify(window.ScheduleApp.state.settings.times[0])');
  check('保存后落进当前课表：第 1 节 = 页面上显示的那两个时间',
    saved0 === '{"start":"' + startBeforeDur + '","end":"' + addMin(startBeforeDur, 50) + '"}',
    String(saved0));
  check('保存后固定时长与每节时长也写回了',
    (await evalJs('window.ScheduleApp.state.settings.fixedDuration')) === true &&
    (await evalJs('window.ScheduleApp.state.settings.classDuration')) === 50);
  check('保存后回到设置页', (await settingsOpen()) && !(await ttOpen()));
  const sum1 = String(await evalJs('document.getElementById("timesSummary").textContent'));
  check('回到设置后入口行的摘要已经跟着更新',
    sum1.indexOf('第 1 节 ' + startBeforeDur + ' 起') > 0, sum1);

  /* ---- 添加一节 + 返回丢弃 ---- */
  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(300);
  const lastEnd = await ttVal(lastIdx, 'end');
  await evalJs('document.getElementById("ttAdd").click();1');
  await wait(250);
  check('「添加」多出一节，时间是接在最后一节后面的',
    (await ttCount()) === sec0 + 1 && (await ttVal(sec0, 'start')) === addMin(lastEnd, 10),
    (await ttCount()) + ' 行 / ' + (await ttVal(sec0, 'start')));
  const backTt = await evalJs('window.handleBack()');
  await wait(300);
  check('返回键：从编辑时间表退回「设置」（不是一把掀回课表）',
    backTt === true && (await settingsOpen()) && !(await ttOpen()), 'handleBack=' + backTt);
  check('返回 = 丢草稿：刚加的第 ' + (sec0 + 1) + ' 节没有被写进课表',
    (await evalJs('window.ScheduleApp.state.settings.sections')) === sec0 &&
    (await evalJs('window.ScheduleApp.state.settings.times.length')) === sec0);

  console.log('\n[15] 左滑删掉一节：后面几节整体上移补位');
  /* 滑动用真实 TouchEvent 驱动，不直接改 style —— 直接改 style 只能证明 CSS 写得对，
     证明不了手势本身（判定阈值、回弹、吞 click）是对的。 */
  const swipeRow = (i, dx) => evalJs(
    '(function(){' +
    'var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'if(!w)return "no-row";' +
    'var box=w.getBoundingClientRect();' +
    'var cy=box.top+box.height/2, x0=box.right-40;' +
    'function fire(type,x,has){' +
    '  var list=has?[new Touch({identifier:1,target:w,clientX:x,clientY:cy})]:[];' +
    '  w.dispatchEvent(new TouchEvent(type,{touches:list,targetTouches:list,' +
    'changedTouches:[new Touch({identifier:1,target:w,clientX:x,clientY:cy})],' +
    'bubbles:true,cancelable:true}));' +
    '}' +
    'fire("touchstart",x0,true);' +
    'for(var k=1;k<=6;k++) fire("touchmove",x0+(' + dx + ')*k/6,true);' +
    'fire("touchend",x0+(' + dx + '),false);' +
    'return "ok";' +
    '})()');
  const mouseSwipeRow = (i, dx) => evalJs(
    '(function(){' +
    'var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'if(!w)return "no-row";' +
    'var box=w.getBoundingClientRect();' +
    'var cy=box.top+box.height/2, x0=box.right-40;' +
    'function fire(t,type,x){w.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,' +
    'clientX:x,clientY:cy,button:0,view:window}));}' +
    'fire(w,"mousedown",x0);' +
    'for(var k=1;k<=6;k++) fire(w,"mousemove",x0+(' + dx + ')*k/6);' +
    'document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,clientX:x0+(' + dx + '),clientY:cy,button:0,view:window}));' +
    'return "ok";' +
    '})()');
  const ttOpenRow = (i) => evalJs(
    '(function(){var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'return w?w.classList.contains("open"):null;})()');
  /* 「点一下」必须用真实的 mousedown + mouseup 驱动：
     收起已滑开的行这件事发生在手势的收尾里，直接 .click() 绕过了整条链路。 */
  const mouseTapRow = (i) => evalJs(
    '(function(){' +
    'var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'if(!w)return "no-row";' +
    'var r=w.querySelector(".tt-row"), b=r.getBoundingClientRect();' +
    'var cx=b.left+30, cy=b.top+b.height/2;' +
    'function fire(t){r.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,' +
    'clientX:cx,clientY:cy,button:0,view:window}));}' +
    'fire("mousedown");fire("mouseup");' +
    'return "ok";' +
    '})()');
  const ttRowX = (i) => evalJs(
    '(function(){var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'return w?String(w.querySelector(".tt-row").style.transform||""):null;})()');
  const ttOpenCount = () => evalJs('document.querySelectorAll("#ttList .tt-row-wrap.open").length');
  const ttDelClick = (i) => evalJs(
    '(function(){var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
    'if(!w)return "no-row";w.querySelector(".tt-del").click();return "ok";})()');
  /* 分步滑 + **可控时钟**：速度判定必须用真实的时间差才测得到，
     而真实 wait() 的抖动会让 0.5px/ms 这条线一会儿过一会儿不过。
     所以把页面里的 Date.now 临时换成计数器（滑完立刻还原，别影响后面写库的时间戳）。 */
  const pacedSwipe = async (i, offsets, tickMs) => {
    await evalJs('(function(){' +
      'var w=document.querySelectorAll("#ttList .tt-row-wrap")[' + i + '];' +
      'if(!w)return "no-row";' +
      'var b=w.getBoundingClientRect();' +
      'window.__sw={w:w,x0:b.right-40,cy:b.top+b.height/2};' +
      'window.__realNow=Date.now; window.__clock=100000;' +
      'Date.now=function(){return window.__clock;};' +
      'window.__fire=function(type,x,has){' +
      'var s=window.__sw,l=has?[new Touch({identifier:1,target:s.w,clientX:x,clientY:s.cy})]:[];' +
      's.w.dispatchEvent(new TouchEvent(type,{touches:l,targetTouches:l,' +
      'changedTouches:[new Touch({identifier:1,target:s.w,clientX:x,clientY:s.cy})],' +
      'bubbles:true,cancelable:true}));};' +
      'window.__fire("touchstart",window.__sw.x0,true);return "ok";})()');
    for (const off of offsets) {
      await evalJs('window.__clock += ' + tickMs + ';' +
        'window.__fire("touchmove",window.__sw.x0+' + off + ',true);1');
    }
    await evalJs('window.__clock += ' + tickMs + ';' +
      'window.__fire("touchend",window.__sw.x0,false);Date.now=window.__realNow;1');
  };
  const ttSnapshot = () => evalJs('JSON.stringify((function(){var v=[];' +
    'document.querySelectorAll("#ttList .tt-row").forEach(function(r){' +
    'var i=r.querySelectorAll(".tp");v.push([i[0].value,i[1].value]);});return v;})())');

  await evalJs('window.closeAllMasks();1');
  await wait(200);
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(250);
  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(300);

  const secN = await evalJs('window.ScheduleApp.state.settings.sections');
  const delIdx = 2;
  check('刚进来没有任何一行是滑开的', (await ttOpenCount()) === 0);
  check('每一节外面都套了裁剪容器，「删除」按钮就在它里面',
    (await evalJs('document.querySelectorAll("#ttList .tt-row-wrap").length')) === secN &&
    (await evalJs('document.querySelectorAll("#ttList .tt-del").length')) === secN);

  const rowsBefore = JSON.parse(await ttSnapshot());
  const delta = toMin(rowsBefore[delIdx + 1][0]) - toMin(rowsBefore[delIdx][0]);

  /* 没滑开时按钮在行底下盖着，点它不该删掉任何东西 */
  await ttDelClick(delIdx);
  await wait(200);
  check('没滑开时点「删除」无效（按钮还盖在行底下）', (await ttCount()) === secN);

  /* 滑得不够一半 → 回弹，不留在半路 */
  await swipeRow(delIdx, -30);
  await wait(300);
  check('向左滑不到一半会回弹，不会停在半路上',
    (await ttOpenRow(delIdx)) === false && String(await ttRowX(delIdx) || '') === '',
    String(await ttRowX(delIdx)));

  /* 位移没过半、但甩得快（1.0px/ms）→ 也认，按速度滑开。
     两步 30ms：-36 位移按位置判是「不够」（门槛 -38），按速度判是「够」，
     所以这一条能确定地证明速度分支真的在起作用。 */
  await pacedSwipe(1, [-6, -36], 30);
  await wait(300);
  check('滑得快时按速度判定：位移没过半也能滑开',
    (await ttOpenRow(1)) === true, String(await ttRowX(1)));
  await mouseTapRow(1);
  await wait(250);
  check('甩开的那一行点一下收得回去', (await ttOpenCount()) === 0);

  /* 滑到底 → 红色删除露出来 */
  await swipeRow(delIdx, -90);
  await wait(300);
  check('向左滑到底：这一行滑开，红色「删除」露出来',
    (await ttOpenRow(delIdx)) === true &&
    String(await ttRowX(delIdx)).indexOf('-76px') >= 0, String(await ttRowX(delIdx)));
  check('同一时刻只有这一行是滑开的', (await ttOpenCount()) === 1);
  await wait(700);
  await shot(path.join(outDir, '图26-左滑删除某一节-v1.9.4.png'));

  /* 点删除：行数 -1，后面几节整体上移补位 */
  await ttDelClick(delIdx);
  await wait(400);
  check('点「删除」：行数少一节', (await ttCount()) === secN - 1,
    String(await ttCount()));
  check('被删节的位置由原来下一节顶上（起点正好落到被删节的起点）',
    (await ttVal(delIdx, 'start')) === rowsBefore[delIdx][0],
    (await ttVal(delIdx, 'start')) + ' vs ' + rowsBefore[delIdx][0]);
  check('顶上来那一节的时长不变（搬的是起点，不是按时长重算）',
    toMin(await ttVal(delIdx, 'end')) - toMin(await ttVal(delIdx, 'start')) ===
      toMin(rowsBefore[delIdx + 1][1]) - toMin(rowsBefore[delIdx + 1][0]));
  check('删掉的那一节确实不在了（不是只把文字改掉）',
    JSON.parse(await ttSnapshot()).indexOf(rowsBefore[delIdx + 1]) === -1);
  check('末尾那一节也跟着上移了同一个槽位（整体上移，不是只动相邻一节）',
    toMin(rowsBefore[secN - 1][0]) - toMin(await ttVal(secN - 2, 'start')) === delta,
    String(toMin(rowsBefore[secN - 1][0]) - toMin(await ttVal(secN - 2, 'start'))) + ' vs ' + delta);
  check('删完之后没有行是滑开的（行都重建了）', (await ttOpenCount()) === 0);

  /* 鼠标分支也要能跑（网页版 / 桌面调试） */
  await mouseSwipeRow(0, -90);
  await wait(300);
  check('鼠标左拖也能把行滑开（触摸与鼠标是两条独立分支）',
    (await ttOpenRow(0)) === true, String(await ttRowX(0)));
  /* 点一下已经滑开的那一行 → 收起来 */
  await mouseTapRow(0);
  await wait(300);
  check('点一下已滑开的行会收起来', (await ttOpenCount()) === 0);

  /* 返回 = 丢草稿 */
  const backDel = await evalJs('window.handleBack()');
  await wait(300);
  check('删完不保存直接返回：课表里还是原来那么多节（草稿丢弃）',
    backDel === true &&
    (await evalJs('window.ScheduleApp.state.settings.sections')) === secN &&
    (await evalJs('window.ScheduleApp.state.settings.times.length')) === secN);

  /* 再来一次，这次保存下去。滑完**立刻**点删除：
     这正是「用时间窗吞 click」那种写法会翻车的时序。 */
  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(300);
  check('再进来行数回到原来的节数', (await ttCount()) === secN, String(await ttCount()));
  await swipeRow(delIdx, -90);
  await wait(120);
  check('重新进来后左滑仍然能滑开', (await ttOpenRow(delIdx)) === true, String(await ttRowX(delIdx)));
  await ttDelClick(delIdx);
  await wait(400);
  check('滑完立刻点「删除」也要删得掉（补发的 click 只吃一个，不按时间窗）',
    (await ttCount()) === secN - 1, String(await ttCount()));
  await evalJs('document.getElementById("ttSave").click();1');
  await wait(400);
  const afterSec = await evalJs('window.ScheduleApp.state.settings.sections');
  const afterLen = await evalJs('window.ScheduleApp.state.settings.times.length');
  check('保存后节数与时间表长度一起落库', afterSec === secN - 1 && afterLen === secN - 1,
    afterSec + ' / ' + afterLen);
  check('保存后回到设置页，且摘要跟着更新',
    (await settingsOpen()) && !(await ttOpen()) &&
    String(await evalJs('document.getElementById("timesSummary").textContent')).indexOf('共 ' + (secN - 1) + ' 节') === 0,
    String(await evalJs('document.getElementById("timesSummary").textContent')));

  console.log('\n[16] 全程零上传：学校列表只落本机');
  const stored = await evalJs(
    'localStorage.getItem(window.Schools.KEY)'
  );
  check('「我的学校」确实落在本机 localStorage 里', !!stored && /demob/.test(stored),
    String(stored).slice(0, 60));
  check('页面没有任何外链脚本（离线可用）',
    await evalJs('[].slice.call(document.scripts).every(function(s){' +
      'return !/^https?:/.test(s.src)})'));

  console.log('\n[17] 课程卡：鲜艳实色底 + 包边随主题换色 + 文字居中 + 调色盘换色 + 一行三字 + 相邻卡片的缝（v1.9.11）');

  /* 上一段结束时停在设置页：先清场再进来。
     约定就是**切换场景前先断言一次清场** —— openMask 不做互斥，
     靠调用方先 closeMask；不清场的话截图会被下层弹层盖住。 */
  if (await evalJs('document.getElementById("maskSettings").classList.contains("show")')) {
    await evalJs('document.getElementById("btnSettingsClose").click();1');
    await wait(300);
  }
  check('进入本段前页面是干净的（没有残留弹层）',
    (await evalJs('document.querySelectorAll(".mask.show").length')) === 0,
    String(await evalJs('document.querySelectorAll(".mask.show").length')));

  /* 这一段几乎不写死任何色值：颜色取自真实 computed style、取自 Store 的真函数，
     行数由 Range 量真实文字的矩形个数 —— 改配色档位、改取色器布局都不会让用例失效。 */

  /* 卡片上真实落下的东西：色相变量 / 底色 / 字色 / 课程名宽度与行数。
     `lines` 用 Range 数真实文字矩形：块级元素的 clientHeight 只能反推行数，
     而 Range 直接把「排了几行」量出来。 */
  const cardProbe = async (id) => JSON.parse(await evalJs(
    '(function(){var el=document.querySelector(\'.course[data-id="' + id + '"]\');' +
    'if(!el)return "null";var cs=getComputedStyle(el),nm=el.querySelector(".c-name");' +
    'if(!nm)return "null";var ns=getComputedStyle(nm),rg=document.createRange();' +
    'rg.selectNodeContents(nm);' +
    'return JSON.stringify({h:cs.getPropertyValue("--h").trim(),bg:cs.backgroundColor,' +
    'fg:cs.color,w:nm.clientWidth,fs:parseFloat(ns.fontSize),lines:rg.getClientRects().length,' +
    'txt:nm.textContent});})()'));

  /* 找一个「整列都没课」的星期来放测试课：列里如果还有别的课，
     layout() 会把这一簇分栏，卡片变窄就量不准「一行三字」了。 */
  const slot = JSON.parse(await evalJs(
    '(function(){var cs=window.ScheduleApp.state.courses;' +
    'function clean(d){return !cs.some(function(c){return c.day===d});}' +
    'for(var d=7;d>=1;d--){if(clean(d))return JSON.stringify({d:d,s:1});}' +
    'for(var d=7;d>=1;d--){for(var s=1;s<=7;s++){' +
    'if(!cs.some(function(c){return c.day===d&&c.start<=s+1&&c.end>=s}))' +
    'return JSON.stringify({d:d,s:s});}}return null;})()')) || { d: 7, s: 1 };

  /* 表单里读出「颜色这一行」的当前状态 —— 三个出口（取消 / 保存 / 点外部）
     都用同一组断言，行为不一致的话任一条就会红。 */
  const colorRow = async () => JSON.parse(await evalJs(
    '(function(){var p=document.getElementById("btnPickColor"),a=document.getElementById("btnAutoColor");' +
    'return JSON.stringify({bg:p?getComputedStyle(p).getPropertyValue("--bg").trim():"",' +
    'pickOn:p?p.classList.contains("is-on"):false,autoOn:a?a.classList.contains("is-on"):false,' +
    'form:document.getElementById("maskAdd").classList.contains("show"),' +
    'picker:document.getElementById("maskColor").classList.contains("show")});})()'));

  /* 在方块 / 色相条上按下并拖到相对位置 (fx, fy)。
     用真实 MouseEvent，而不是直接改 style —— 那只证明 CSS 写得对，
     证明不了「按住能拖」。bindPick 把 mousemove/mouseup 挂在 document 上，
     所以拖动的那两下要派发到 document。 */
  const dragOn = async (id, fx, fy) => evalJs(
    '(function(){var el=document.getElementById("' + id + '"),r=el.getBoundingClientRect(),' +
    'x=r.left+r.width*(' + fx + '),y=r.top+r.height*(' + fy + ');' +
    'el.dispatchEvent(new MouseEvent("mousedown",{clientX:x,clientY:y,bubbles:true,cancelable:true}));' +
    'document.dispatchEvent(new MouseEvent("mousemove",{clientX:x,clientY:y,bubbles:true,cancelable:true}));' +
    'document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));return 1;})()');

  const typeHex = async (v) => evalJs(
    '(function(){var i=document.getElementById("cpHex");i.value=' + JSON.stringify(v) + ';' +
    'i.dispatchEvent(new Event("input",{bubbles:true}));return i.value;})()');

  /* 「#RRGGBB」在这台机器上会渲染成什么 computed 值 —— 不在测试里写死 rgb 三元组 */
  const expectRgb = async (hex) => evalJs(
    '(function(){var c=window.Store.hexToRgb(' + JSON.stringify(hex) + ');' +
    'return "rgb("+Math.round(c[0]*255)+", "+Math.round(c[1]*255)+", "+Math.round(c[2]*255)+")";})()');

  await evalJs('document.getElementById("btnAdd").click();1');
  await wait(300);

  check('颜色行是「一个调色盘 + 一个自动」两个按钮（不再是一排色点）',
    (await evalJs('!!document.getElementById("btnPickColor")')) === true &&
    (await evalJs('!!document.getElementById("btnAutoColor")')) === true &&
    (await evalJs('!!document.getElementById("addHues")')) === false);
  check('刚打开时是「自动」：自动亮着、调色盘没亮',
    (await colorRow()).autoOn === true && (await colorRow()).pickOn === false);

  /* 三字课名 —— 量的就是「一行三个字」。
     用真实 input 事件（而不是光改 .value）：自动色是跟着课名算的，
     监听 input 才刷得动；光改 value 的话页面上根本不知道课名变了。
     教室也要填：v1.9.7 起「教室在卡片里居中」是要量的，没教室就量不到。
     刻意挑一个**短到会折行**的教室名（5 个字 = 50px 拆进 37px 的内容宽），
     折出来的最后一行明显窄于内容宽 —— 左对齐时它左边留白是 0，
     居中时两边相等，这样「居中」才真的被量到（课程名三个字几乎占满，
     留白只差 2.5px，作为探针太钝）。 */
  await evalJs('(function(){' +
    'var n=document.getElementById("addName");n.value="高等数";' +
    'n.dispatchEvent(new Event("input",{bubbles:true}));' +
    'document.getElementById("addLocation").value="教三楼301";' +
    'document.getElementById("addDay").value="' + slot.d + '";' +
    'document.getElementById("addStart").value="' + slot.s + '";' +
    'document.getElementById("addEnd").value="' + (slot.s + 1) + '";' +
    'document.getElementById("addWeeks").value="1-16";return 1;})()');
  await wait(250);

  /* 自动色跟着课名走：调色盘中间那块显示的就是这张卡将来的颜色 */
  const autoHexNow = await evalJs('window.Store.cardHex(window.ScheduleApp.hueOf("高等数"))');
  check('「自动」时调色盘中间显示的就是这张卡将来的颜色（点开之前就知道是什么色）',
    (await colorRow()).bg === autoHexNow, (await colorRow()).bg + ' / ' + autoHexNow);

  /* ---- 打开取色器：子弹层，进来前先收表单 ---- */
  await evalJs('document.getElementById("btnPickColor").click();1');
  await wait(400);

  check('取色器进来时先收掉表单（弹层不叠）',
    (await colorRow()).picker === true && (await colorRow()).form === false);

  const hasEls = JSON.parse(await evalJs(
    'JSON.stringify(["cpArea","cpHueBar","cpDot","cpHueDot","cpPreview","cpHex","cpTip"]' +
    '.reduce(function(o,id){o[id]=!!document.getElementById(id);return o},{}))'));
  check('取色器结构齐：方块 + 色相条 + 两个指示点 + 预览块 + 色值框 + 提示行',
    Object.keys(hasEls).every((k) => hasEls[k]), JSON.stringify(hasEls));

  check('打开时停在「这张卡现在的颜色」上，不是一个凭空默认值',
    (await evalJs('document.getElementById("cpHex").value')) === autoHexNow,
    await evalJs('document.getElementById("cpHex").value'));

  /* 方块 = HSV：横向饱和度、纵向明度。左上角 = 白（S=0,V=1），左下角 = 黑（V=0）。
     边角上用容差而不是等值：手指落在方块最下一像素时，
     getBoundingClientRect 的浮点减法会算出 y≈0.996（不是 1），
     于是明度是 0.004 而不是 0 —— 肉眼无差，但等值断言会红。 */
  const channelMax = (h) => Math.max.apply(null,
    [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)));
  const channelMin = (h) => Math.min.apply(null,
    [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16)));

  await dragOn('cpArea', 0, 0);
  await wait(150);
  const topLeft = await evalJs('document.getElementById("cpHex").value');
  await dragOn('cpArea', 0, 1);
  await wait(150);
  const bottomLeft = await evalJs('document.getElementById("cpHex").value');
  check('方块横向控饱和度、纵向控明度（左上=白、左下=黑）',
    /^#[0-9A-F]{6}$/.test(topLeft) && channelMin(topLeft) >= 250 &&
    /^#[0-9A-F]{6}$/.test(bottomLeft) && channelMax(bottomLeft) <= 5,
    topLeft + ' / ' + bottomLeft);

  /* 色相条顶端是正红；方块右上角 = 该色相的纯色 */
  await dragOn('cpHueBar', 0.5, 0);
  await wait(150);
  await dragOn('cpArea', 1, 0);
  await wait(150);
  const vivid = await evalJs('document.getElementById("cpHex").value');
  check('色相条顶端是正红（色相条真的在控色相）', vivid === '#FF0000', vivid);

  /* 「过亮」现在要**真的过亮**才算数：v1.9.7 起卡片默认色本身就是鲜艳档
     （白字对比度本来就低到 1.35），提示阈值跟着降到「< 1.35 才报警」，
     于是正红（4.0:1）已经不该报警了。拉一条纯黄出来 —— 白字只有 1.07:1，
     这才是真正该提醒的那一档。 */
  await dragOn('cpHueBar', 0.5, 1 / 6);
  await wait(150);
  await dragOn('cpArea', 1, 0);
  await wait(150);
  const yellow = await evalJs('document.getElementById("cpHex").value');
  check('选了过亮的色就给出提示（自定义色不自动调明度，可读性只能靠这句话）',
    /^#FF/.test(yellow) &&
    (await evalJs('document.getElementById("cpTip").textContent.length')) > 0,
    yellow + ' → ' + await evalJs('document.getElementById("cpTip").textContent'));

  /* ---- 直接敲色值 ---- */
  const blueRgb = await expectRgb('#1149A6');
  await typeHex('#1149a6');
  await wait(200);
  check('色值可以直接敲（小写也认），并且立刻反映到预览块上',
    (await evalJs('getComputedStyle(document.getElementById("cpPreview")).backgroundColor')) === blueRgb,
    await evalJs('getComputedStyle(document.getElementById("cpPreview")).backgroundColor'));
  check('色值敲成一个够暗的色之后，提示自动收起来',
    (await evalJs('document.getElementById("cpTip").textContent')) === '',
    await evalJs('document.getElementById("cpTip").textContent'));

  await evalJs('(function(){var i=document.getElementById("cpHex");i.focus();i.value="#1149A";' +
    'i.dispatchEvent(new Event("input",{bubbles:true}));i.blur();return 1;})()');
  await wait(200);
  check('色值敲到一半（不合法）不当真，失焦后还原成当前生效的色',
    (await evalJs('document.getElementById("cpHex").value')) === '#1149A6' &&
    (await evalJs('getComputedStyle(document.getElementById("cpPreview")).backgroundColor')) === blueRgb,
    await evalJs('document.getElementById("cpHex").value'));

  await shot(path.join(outDir, '图29-取色器-v1.9.7.png'));

  /* ---- 三个出口都退回表单，而不是把人扔回课表 ---- */
  await evalJs('document.getElementById("btnCpCancel").click();1');
  await wait(350);
  check('「取消」退回表单，且表单里的颜色一点没被改',
    (await colorRow()).form === true && (await colorRow()).picker === false &&
    (await colorRow()).bg === autoHexNow && (await colorRow()).autoOn === true);

  await evalJs('document.getElementById("btnPickColor").click();1');
  await wait(350);
  await evalJs('document.getElementById("maskColor").click();1');
  await wait(350);
  check('点取色器外面也是退回表单（不是把人扔回课表）',
    (await colorRow()).form === true && (await colorRow()).picker === false);

  await evalJs('document.getElementById("btnPickColor").click();1');
  await wait(350);
  const consumed = await evalJs('window.handleBack()');
  await wait(350);
  check('系统返回键把它当子弹层处理：退回表单而不是全关',
    consumed === true && (await colorRow()).form === true && (await colorRow()).picker === false);

  /* ---- 选一个色、保存、落库 ---- */
  await evalJs('document.getElementById("btnPickColor").click();1');
  await wait(350);
  await typeHex('#1149A6');
  await wait(200);
  await evalJs('document.getElementById("btnCpSave").click();1');
  await wait(400);
  check('「保存」退回表单：调色盘亮起来并显示所选颜色，「自动」熄灭',
    (await colorRow()).form === true && (await colorRow()).picker === false &&
    (await colorRow()).pickOn === true && (await colorRow()).autoOn === false &&
    (await colorRow()).bg === '#1149A6',
    (await colorRow()).bg);

  await shot(path.join(outDir, '图28-课程颜色行-v1.9.7.png'));

  /* 夜晚主题下再看一眼：这两块都压在换过底色的面板上（深色面板 + 深色按钮），
     调色盘的内描边、取色器的面板对比度都得重新成立。
     另外顺手确认一件事：**用户挑的卡片颜色不跟着主题跳**。 */
  await evalJs('window.Store.setTheme("dark"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);
  check('夜晚主题下颜色行照旧：调色盘仍显示所选色，不跟着主题跑',
    (await colorRow()).bg === '#1149A6' && (await colorRow()).pickOn === true);
  await evalJs('document.getElementById("btnPickColor").click();1');
  await wait(450);
  await shot(path.join(outDir, '图30-取色器-夜晚-v1.9.7.png'));
  await evalJs('document.getElementById("btnCpCancel").click();1');
  await wait(350);
  await evalJs('window.Store.setTheme("light"); window.ScheduleApp.applyTheme(); 1');
  await wait(350);
  check('切回白天主题，颜色行没有被主题切换改坏',
    (await colorRow()).bg === '#1149A6' && (await colorRow()).form === true);

  await evalJs('document.getElementById("btnAddSave").click();1');
  await wait(500);

  const mine = JSON.parse(await evalJs(
    'JSON.stringify(window.ScheduleApp.state.courses.filter(function(c){return c.name==="高等数"})[0]||null)'));
  const newId = mine ? mine.id : null;
  check('自定义色落库到 course.color（大写归一），而 hue 被显式清成 null',
    !!mine && mine.color === '#1149A6' && mine.hue === null,
    mine ? mine.color + ' / hue=' + mine.hue : 'null');

  const probe = await cardProbe(newId);
  check('卡片底色就是这个自定义色，没有被悄悄调过明度',
    probe.bg === blueRgb, probe.bg + ' / ' + blueRgb);
  check('课程名在一行里放下三个字（数真实文字行数，不是看 CSS 写没写 nowrap）',
    probe.lines === 1 && probe.txt === '高等数',
    probe.lines + ' 行：' + probe.txt);
  check('宽度预算是够三个汉字的（内容宽 ≥ 3 × 字号，靠省内边距而不是缩字号）',
    probe.w >= 3 * probe.fs, probe.w + 'px / 3×' + probe.fs + 'px');
  check('课程名是白的',
    probe.fg === 'rgb(255, 255, 255)', probe.fg);

  /* 不只是刚新建的这张：**屏幕上每一张卡**都过一遍对比度（含导入来的那些）。
     自动配色的课走的是 store.js 那套明度算法，同样要过关。
     **标准在 v1.9.7 降了**：卡片配色改成「鲜艳优先」，白字对比度从 4.60:1 掉到
     1.35:1（用户明确要求「哪怕阳光下看不清楚」）。这里改成断言**兜底线**，
     而不是把这条删掉 —— 线还在，只是位置低了。
     （12 档色相全量达标由 smoke-test 直接调真函数断言，这里只保证落屏的没跑偏。） */
  const minC = Number(await evalJs('window.Store.CARD_CONTRAST_MIN'));
  const autoCards = JSON.parse(await evalJs(
    'JSON.stringify([].slice.call(document.querySelectorAll(".course"))' +
    '.map(function(el){return getComputedStyle(el).backgroundColor;}))'));
  const autoC = autoCards.map(contrastWhite);
  check('屏幕上每一张卡都是不透明实色底，白字对比度不低于兜底线（v1.9.7 起不再是 4.5:1）',
    autoCards.length >= 1 && autoCards.every((v) => /^rgb\(/.test(v)) &&
    Math.min.apply(null, autoC) >= minC - 0.05,
    autoCards.length + ' 张，最差 ' + Math.min.apply(null, autoC).toFixed(2) +
    ':1 / 兜底 ' + minC.toFixed(2) + ':1');

  /* 包边 + 文字居中：都**量真实几何**，不是看 CSS 里写没写。
     这一段跑在白天主题下，所以包边应当是深灰 #3a3a3c —— v1.9.9 起包边颜色跟着主题走，
     若把颜色写死成白色，这条就会红（夜晚那条在下面另量像素）。
     行留白用 Range 的 getClientRects() 逐行量（一行的左右留白相等才叫居中；
     左对齐时最后那条短行的左留白一定是 0）。 */
  const look = JSON.parse(await evalJs(
    '(function(){var el=document.querySelector(\'.course[data-id="' + newId + '"]\');' +
    'var cs=getComputedStyle(el),r=el.getBoundingClientRect();' +
    'var cl=r.left+parseFloat(cs.paddingLeft),cr=r.right-parseFloat(cs.paddingRight);' +
    'function lines(sel){var n=el.querySelector(sel);if(!n)return null;' +
    'var rg=document.createRange();rg.selectNodeContents(n);' +
    'return [].slice.call(rg.getClientRects()).map(function(b){' +
    'return {l:+(b.left-cl).toFixed(2),r:+(cr-b.right).toFixed(2),w:+b.width.toFixed(2)};});}' +
    'var nm=el.querySelector(".c-name"),mt=el.querySelector(".c-meta");' +
    'var loc=el.querySelector(".c-meta.loc");' +
    'var nr=nm?nm.getBoundingClientRect():null,lrr=loc?loc.getBoundingClientRect():null;' +
    'return JSON.stringify({cw:+(cr-cl).toFixed(2),name:lines(".c-name"),loc:lines(".c-meta.loc"),' +
    'ta:cs.textAlign,taName:nm?getComputedStyle(nm).textAlign:"",' +
    'taMeta:mt?getComputedStyle(mt).textAlign:"",' +
    'shadow:cs.boxShadow,bt:cs.borderTopWidth,bl:cs.borderLeftWidth,' +
    /* 纵向分配用到的四个真值（v1.9.13） */
    'cT:+(r.top).toFixed(2),cB:+(r.bottom).toFixed(2),padT:parseFloat(cs.paddingTop),' +
    'nT:nr?+(nr.top).toFixed(2):null,nB:nr?+(nr.bottom).toFixed(2):null,' +
    'lT:lrr?+(lrr.top).toFixed(2):null,lB:lrr?+(lrr.bottom).toFixed(2):null});})()'));

  check('白天主题下卡片是浅暖灰包边（#a89a86），且是 box-shadow 外描边（border 会吃掉「一行三个字」的宽度）',
    /rgb\(168, 154, 134\) 0px 0px 0px 2px/.test(look.shadow) &&
    look.bt === '0px' && look.bl === '0px',
    look.shadow + ' / border=' + look.bt);

  const centered = (ls) => Array.isArray(ls) && ls.length > 0 &&
    ls.every((g) => Math.abs(g.l - g.r) <= 1.5);
  check('课程名在卡片里居中（不是左对齐）',
    look.ta === 'center' && look.taName === 'center' && centered(look.name),
    'text-align=' + look.taName + ' / 各行留白 ' +
    (look.name || []).map((g) => g.l + '|' + g.r).join(' '));
  check('教室也在卡片里居中（用折行后那条短行量，左对齐时它左边留白会是 0）',
    look.taMeta === 'center' && centered(look.loc) &&
    look.loc.some((g) => g.w < look.cw - 6),
    '各行留白 ' + (look.loc || []).map((g) => g.l + '|' + g.r + '(' + g.w + 'px)').join(' ') +
    ' / 内容宽 ' + look.cw + 'px');

  /* ---- 纵向分配：课程名居中 + 教室沉底（v1.9.13）----
     用户报：「课程名称希望居中，同时上课教室沉底在最下方但不希望被遮挡」。
     修之前卡片虽然是 flex 纵向，但**一条纵向分配都没有** —— 两行内容全堆在顶部，
     2 节连排的卡片 106px 高、内容只占 25px，下面近 60px 是空的，
     课程名既不在中间、教室也没沉底（量出来教室离卡片底 60px+）。
     现在课程名靠上下 auto margin 吃掉剩余空间并居中、教室留在最后贴着底边。
     三个量都是**绝对坐标**，不比差值 —— 比差值会把「文字比容器宽」这类事判反。 */
  const nameMid = (look.nT + look.nB) / 2;
  const nameMidWant = (look.cT + look.padT + look.lT) / 2;   // 内容区顶 ~ 教室顶 的中点
  check('课程名**垂直**居中：中点落在「内容区顶 ~ 教室顶」的中点（±2px）',
    Math.abs(nameMid - nameMidWant) <= 2,
    '课名中点 ' + nameMid.toFixed(2) + ' / 期望 ' + nameMidWant.toFixed(2));
  check('教室沉在卡片底边：离底 0~6px（修之前它跟着课程名一起堆在顶部，离底 60px+）',
    look.cB - look.lB >= 0 && look.cB - look.lB <= 6,
    '离底 ' + (look.cB - look.lB).toFixed(2) + 'px');
  check('教室完整落在卡片内（沉底之后没有被 overflow 裁掉）',
    look.lB <= look.cB && look.lT >= look.cT,
    '教室 ' + look.lT + '~' + look.lB + ' / 卡片 ' + look.cT + '~' + look.cB);

  /* ---- 包边：**量真实像素**（v1.9.9，v1.9.13 加了下限）----
     这一版改的全是「CSS 说得对但看不见」的层面：
     · v1.9.7 的白边在白天是白压白，靠肉眼看截图才发现；
     · v1.9.8 用「白边 + 外面一圈暗线」去补，白天成了两层、夜晚那条暗线又看不见；
     · v1.9.9 让包边自己换色 —— 白天深灰、夜晚纯白；
     · v1.9.13 白天那档从暖深灰 #3a342b（对底面 12.11:1，用户嫌「像黑框、突兀」）
       换成浅暖灰 #a89a86（2.71:1，divider 量级）。
     包边在 computed style 里永远是漂亮的一串（`rgb(168, 154, 134) 0px 0px 0px 2px`），
     **被盖住、没画、两处声明写反，它都照样返回**。所以两个主题各扫一行像素、穿过卡片
     左边缘，要求出现「底面 → 包边（与底面明显反差）→ 色块」：白天底面是白、包边必须
     暗一截；夜晚底面是深的、包边必须亮一截。
     ⚠ 白天这一条现在**两头都卡**：太浅 → 又变回「白压白」看不见；太深 → 又变回黑框。
     这类「值会变」的颜色，只写一个上限是挡不住下一次改配色的。 */
  const rect = JSON.parse(await evalJs(
    '(function(){var r=document.querySelector(\'.course[data-id="' + newId + '"]\').getBoundingClientRect();' +
    'return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height});})()'));
  /* 横向扫 14 CSS px，只取卡片垂直中点那一行 —— 避开圆角，那儿的边缘是直的 */
  const scanEdge = async () => {
    const scanW = 14;
    const png = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: rect.l - 7, y: rect.t + rect.h / 2, width: scanW, height: 1, scale: 1 },
    });
    const img = decodePng(Buffer.from(png.data, 'base64'));
    const k = img.w / scanW;                       // 设备像素 / CSS 像素
    const band = [];
    for (let i = 0; i < img.w; i++) {
      const q = i * img.bpp;
      band.push(Math.round(0.2126 * img.data[q] + 0.7152 * img.data[q + 1] + 0.0722 * img.data[q + 2]));
    }
    return { band, px: (off) => band[Math.round((7 + off) * k)] };   // 相对卡片左边缘，负 = 卡片外
  };

  const day = await scanEdge();
  check('白天：卡片外沿是「近白底面 → 浅暖灰包边 → 色块」，包边比底面明显暗一截（「白压白」测不过）',
    day.px(-4) >= 245 && day.px(-4) - day.px(-1) >= 25 && day.px(1) < 200,
    '底面 ' + day.px(-4) + ' / 包边 ' + day.px(-1) + ' / 卡片内 ' + day.px(1) +
    ' ｜ 扫描 ' + day.band.join(','));
  check('白天的包边不再是一道近黑线（包边亮度 ≥ 120；旧的 #3a342b 实测 53，会被这条挡下）',
    day.px(-1) >= 120,
    '包边亮度 ' + day.px(-1));
  await shot(path.join(outDir, '图37-课程卡浅暖灰包边-白天-v1.9.13.png'));

  /* 夜晚：底面深、包边是白的 —— 两个主题的包边颜色确实不一样，白边也只在这儿才存在。 */
  await evalJs('window.Store.setTheme("dark"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);
  const night = await scanEdge();
  check('夜晚：卡片外沿是「深底 → 纯白包边 → 色块」（包边没跟着换成白就测不过）',
    night.px(-4) <= 90 && night.px(-1) >= 235 && night.px(1) < 200,
    '底面 ' + night.px(-4) + ' / 包边 ' + night.px(-1) + ' / 卡片内 ' + night.px(1) +
    ' ｜ 扫描 ' + night.band.join(','));
  await shot(path.join(outDir, '图31-课程卡白边-夜晚-v1.9.9.png'));
  await evalJs('window.Store.setTheme("light"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);

  /* ---- 相邻卡片之间的缝（v1.9.11）----
     用户报的：「左右两日同时间的课程卡片描边会重合，中间没有缝隙」。
     根因是包边**向外扩** edge-w，而卡片只内缩了同样多 ⇒ 相减恰好为 0，
     两条边严丝合缝贴成一条 4px 粗的深灰线（同一列上下相邻的两节同理）。
     修法是给 --col-gap 加 3px、并从卡片内边距里省回宽度；纵向把 pad-y 收到 3px。
     这里量三样真东西：横向盒间距、纵向盒间距，以及**缝里到底是底面还是包边**
     —— 前两条是几何，最后一条才是用户眼里的「有没有缝」。 */
  /* 本段前面把课表清空过、只留了一两门课，凑不出「相邻两天 + 同一时间」，
     所以这里先**造一版最小数据**（测完原样还原）：
     · 周三 1-2 节 + 周四 1-2 节 —— 横向缝：紧挨着的两天、纵向完全重叠；
     · 再给周三补一门 3-4 节 —— 纵向缝：同一列里上下相邻的两节课。
     直接改 state 再 render，跟本文件别处一样（这里不是在测「加课」那条链路）。
     为了不污染持久化数据，原始 courses 先存字符串，测完写回去。 */
  const savedCourses = await evalJs('JSON.stringify(window.ScheduleApp.state.courses)');
  await evalJs('(function(){var S=window.ScheduleApp.state;' +
    'var W=[];for(var i=1;i<=16;i++)W.push(i);' +
    'function cp(id,d,s,e){return {id:id,name:"缝"+d+"-"+s,day:d,start:s,end:e,' +
    'weeks:W,weeksText:"1-16周",teacher:"",location:"",color:null,hue:null};}' +
    'S.courses=[cp("seam-a",3,1,2),cp("seam-b",4,1,2),cp("seam-c",3,3,4)];' +
    'S.viewWeek=1;window.Store.save();window.ScheduleApp.render();})();1');
  await wait(350);
  await evalJs('var g=document.getElementById("gridWrap"); if(g)g.scrollTop=0; 1');
  await wait(250);

  const edgeW = Number(await evalJs(
    'parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--card-edge-w"))'));
  const seam = JSON.parse(await evalJs(
    '(function(){var cs=[].slice.call(document.querySelectorAll(".course")),bx=null,by=null;' +
    'var VH=window.innerHeight;' +
    'cs.forEach(function(a){cs.forEach(function(b){if(a===b)return;' +
    'var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();' +
    /* 只认视口内的一对：截图 clip 拍不到视口外，量了也白量 */
    'if(ra.top<56||rb.bottom>VH-8)return;' +
    'var da=+a.parentNode.getAttribute("data-day"),db=+b.parentNode.getAttribute("data-day");' +
    /* 横向：紧挨着的两天（周N → 周N+1），纵向还得有重叠才叫「同时间」 */
    'if(db-da===1){var ov=Math.min(ra.bottom,rb.bottom)-Math.max(ra.top,rb.top);' +
    'if(ov>=8){var g=rb.left-ra.right;if(!bx||g<bx.g)bx={g:+g.toFixed(2),' +
    'x:+(ra.right+g/2).toFixed(2),y:+(Math.max(ra.top,rb.top)+ov/2).toFixed(2),"ov":+ov.toFixed(2)};}}' +
    /* 纵向：同一天里上下相邻的两节课 */
    'if(da===db){var vg=rb.top-ra.bottom;if(vg>0.5&&(!by||vg<by.g))by={g:+vg.toFixed(2),' +
    'y:+(ra.bottom+vg/2).toFixed(2),x:+(ra.left+Math.min(ra.width,rb.width)/2).toFixed(2)};}' +
    '});});return JSON.stringify({x:bx,y:by});})()'));

  check('量到了一对「相邻两天 + 纵向重叠」的卡片（哨兵：找不到会让下面两条假绿）',
    !!seam.x && seam.x.ov >= 8,
    seam.x ? '重叠 ' + seam.x.ov + 'px' : 'null');
  check('相邻两天的卡片盒之间真留出了间距，扣掉两条外扩包边后净缝 ≥ 2px',
    !!seam.x && seam.x.g - 2 * edgeW >= 2,
    seam.x ? seam.x.g + 'px − 2×' + edgeW + 'px = ' +
      (seam.x.g - 2 * edgeW).toFixed(2) + 'px 净缝' : 'null');
  check('同一列里上下相邻的两节课之间也有净缝（v1.9.10 及以前是 0，两节课粘连成一条）',
    !!seam.y && seam.y.g - 2 * edgeW >= 1.5,
    seam.y ? seam.y.g + 'px − 2×' + edgeW + 'px = ' +
      (seam.y.g - 2 * edgeW).toFixed(2) + 'px 净缝' : 'null');

  /* 缝里必须看得到**底面**，而不是被包边填满。
     判据不再写死亮度 250 / 80 —— 底面颜色现在跟着主题令牌走（v1.9.12 调暖后
     白天是 #fffdf8、夜晚是 #1d1913），写死的数字一旦碰上改配色，就会静默退化成
     一条「碰巧还能过」的弱断言。这里直接读页面上的 --surface 折成亮度，要求缝里
     出现一个**贴着底面亮度**的像素（±6）。
     卡片自身是 HSL 60% 的鲜艳色（最亮的黄 ≈216）、包边白天 ≈52 / 夜晚 255，
     三者跟底面在两个主题下都拉得开，不会误判成对面那一种。 */
  const scanSeam = async () => {
    const w = 11;
    const png = await send('Page.captureScreenshot', {
      format: 'png', fromSurface: true,
      clip: { x: seam.x.x - w / 2, y: seam.x.y, width: w, height: 1, scale: 1 },
    });
    const img = decodePng(Buffer.from(png.data, 'base64'));
    const k = img.w / w;
    const band = [];
    for (let i = 0; i < img.w; i++) {
      const q = i * img.bpp;
      band.push(Math.round(0.2126 * img.data[q] + 0.7152 * img.data[q + 1] + 0.0722 * img.data[q + 2]));
    }
    /* 中间 3 CSS px 就是那道缝；窗口取到 5px 是容忍亚像素偏移 */
    const a = Math.round((w / 2 - 2.5) * k), b = Math.round((w / 2 + 2.5) * k);
    return { mid: band.slice(a, b), band };
  };

  /* 注意：这里**不做线性化**，直接拿伽马编码的 0~255 通道加权 —— 必须与下面
     扫描像素时算 band 的那条公式**逐字一致**，否则两边一个用线性亮度、一个用
     编码亮度，同一个颜色会差出一大截（#1d1913 线性算出来是 3、编码算是 25），
     断言就会凭空变红。 */
  const hexLuma = (hex) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
    if (!m) return NaN;
    return Math.round(0.2126 * parseInt(m[1], 16) +
      0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16));
  };
  const surfaceLuma = async () => hexLuma(await evalJs(
    'getComputedStyle(document.documentElement).getPropertyValue("--surface")'));

  const daySurf = await surfaceLuma();
  const daySeam = seam.x ? await scanSeam() : { mid: [], band: [] };
  check('白天：那道缝里看得到底面（亮度贴着 --surface，修之前这里全是包边的深灰）',
    daySeam.mid.some((v) => Math.abs(v - daySurf) <= 6),
    '缝中 ' + daySeam.mid.join(',') + ' ｜ --surface 亮度 ' + daySurf +
    ' ｜ 全带 ' + daySeam.band.join(','));

  await evalJs('window.Store.setTheme("dark"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);
  const nightSurf = await surfaceLuma();
  const nightSeam = seam.x ? await scanSeam() : { mid: [], band: [] };
  check('夜晚：那道缝里看得到底面（亮度贴着 --surface，修之前这里全是包边的纯白）',
    nightSeam.mid.some((v) => Math.abs(v - nightSurf) <= 6),
    '缝中 ' + nightSeam.mid.join(',') + ' ｜ --surface 亮度 ' + nightSurf +
    ' ｜ 全带 ' + nightSeam.band.join(','));

  await evalJs('window.Store.setTheme("light"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);
  await shot(path.join(outDir, '图34-相邻卡片的缝-v1.9.11.png'));

  /* 把造出来的三门课撤掉，还原成本段进来时的样子 —— 后面还有用例要看真实课表 */
  await evalJs('window.ScheduleApp.state.courses=' + savedCourses +
    ';window.Store.save();window.ScheduleApp.render();1');
  await wait(300);
  check('缝的验证用完把课表还原了（不给后面的用例留副作用）',
    (await evalJs('window.ScheduleApp.state.courses.some(function(c){' +
      'return String(c.id).indexOf("seam-")===0;})')) === false);

  /* ---- 编辑：调色盘回显成他当初选的那个色 ---- */
  await evalJs('document.querySelector(\'.course[data-id="' + newId + '"]\').click();1');
  await wait(350);
  await evalJs('document.getElementById("btnDetailEdit").click();1');
  await wait(400);
  check('编辑课程时调色盘回显为他当初选的颜色（不是按课名算出来的那个）',
    (await colorRow()).pickOn === true && (await colorRow()).autoOn === false &&
    (await colorRow()).bg === '#1149A6');

  /* 改回「自动」：color 与 hue 都得显式写，漏一个就静默失效 */
  await evalJs('document.getElementById("btnAutoColor").click();1');
  await wait(250);
  check('点「自动」：调色盘熄灭，中间那块显示回按课程名算出来的色',
    (await colorRow()).autoOn === true && (await colorRow()).pickOn === false &&
    (await colorRow()).bg === autoHexNow);

  await evalJs('document.getElementById("btnAddSave").click();1');
  await wait(500);

  const autoHue = await evalJs('window.ScheduleApp.hueOf("高等数")');
  const afterAuto = JSON.parse(await evalJs(
    'JSON.stringify(window.ScheduleApp.state.courses.filter(function(c){return c.name==="高等数"})[0]||null)'));
  check('改回「自动」后：color 与 hue 双双清成 null，卡片回到按课程名算的颜色',
    !!afterAuto && afterAuto.color === null && afterAuto.hue === null &&
    (await cardProbe(newId)).h === String(autoHue),
    afterAuto ? 'color=' + afterAuto.color + ' hue=' + afterAuto.hue + ' / 期望色相 ' + autoHue : 'null');

  /* 收尾：把这门测试课删掉，别留在课表里影响观感。
     **v1.9.20 起这里不用再绕 confirm 了**：删除走的是应用内自绘确认框，
     不会再弹系统对话框。原先那段「临时替换 window.confirm 再还原」的代码
     随之删掉 —— 它当初存在，正是因为 headless 里 window.confirm 会真弹出来
     并让 Runtime.evaluate 一直挂着（CDP 不自动应答），第一次写这段时被卡了 5 分钟。
     现在换成真点那颗按钮，顺带把「删完弹层都收干净」也钉住。 */
  await evalJs('document.querySelector(\'.course[data-id="' + newId + '"]\').click();1');
  await wait(350);
  await evalJs('document.getElementById("btnDetailDelete").click();1');
  await wait(300);
  const delAsk = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'confirm:document.getElementById("maskConfirm").classList.contains("show"),' +
    'detail:document.getElementById("maskDetail").classList.contains("show"),' +
    'title:document.getElementById("confirmTitle").textContent,' +
    'still:window.ScheduleApp.state.courses.some(function(c){return c.name==="高等数"})});})()'));
  check('点「删除」不直接删，先弹应用内确认框（详情那一层同时被收掉，弹层不叠）',
    delAsk.confirm === true && delAsk.detail === false && delAsk.still === true,
    JSON.stringify(delAsk));
  check('确认框的标题写明了删的是课程（不是课表 / 清空）',
    delAsk.title === '删除课程', delAsk.title);
  await evalJs('document.getElementById("confirmOk").click();1');
  await wait(350);
  check('删除这门测试课成功（确认框已放行）',
    (await evalJs('window.ScheduleApp.state.courses.some(function(c){return c.name==="高等数"})')) === false);
  check('删完确认框与详情都收干净，一路回到课表',
    (await evalJs('document.getElementById("maskConfirm").classList.contains("show")')) === false &&
    (await evalJs('document.getElementById("maskDetail").classList.contains("show")')) === false);

  /* ---- 表头「今天」的标注（v1.9.10）----
     它原来是个 20×20 的蓝色圆点，而日期文字「10/2」在 10.5px 下宽过 20px ——
     文字从左右各溢出一截，看着就是「标注得不完全」。改法是圆点 → 圆角矩形，
     而且**宽度跟着文字走**。这里量的是几何本身，不是看 CSS 里写没写：
     文字的每一条 client rect 都必须落在色块**里面**；色块是「圆角矩形」而不是
     「圆」——即宽度明显大于高度、且圆角小于半个高。
     注：今天不一定落在当前显示的那一周（前面把 viewWeek 定死在 1），
     所以先把视图切到本周，量完再切回去。 */
  console.log('\n[18] 表头「今天」：圆角矩形标注，整块兜住日期（v1.9.10）');
  await evalJs('(function(){var st=window.ScheduleApp.state;' +
    'window.__origWeek=st.viewWeek;' +
    'st.viewWeek=window.Store.weekOf(new Date(),st.settings.semesterStart)||1;' +
    'window.ScheduleApp.render();return 1;})()');
  await wait(350);
  const tod = JSON.parse(await evalJs(
    '(function(){var el=document.querySelector(".day-head.is-today .dd");' +
    'if(!el)return JSON.stringify({found:false});' +
    'var cs=getComputedStyle(el),r=el.getBoundingClientRect();' +
    'var rg=document.createRange();rg.selectNodeContents(el);' +
    'var rects=[].slice.call(rg.getClientRects()).map(function(b){' +
    'return {l:+b.left.toFixed(2),r:+b.right.toFixed(2),w:+b.width.toFixed(2)};});' +
    'return JSON.stringify({found:true,text:el.textContent,' +
    'bl:+r.left.toFixed(2),br:+r.right.toFixed(2),' +
    'w:+r.width.toFixed(2),h:+r.height.toFixed(2),radius:cs.borderRadius,' +
    'bg:cs.backgroundColor,fg:cs.color,rects:rects,' +
    'colW:+el.parentNode.getBoundingClientRect().width.toFixed(2)});})()'));
  check('表头里有一个「今天」的标注', tod.found === true, JSON.stringify(tod));
  /* 横向：文字必须落在色块里 —— **比绝对坐标，不要比差值**。
     Range 的 left/right 都是「越大越靠右」，拿 `色块.right - 文字.right` 这类差值
     判断时符号方向极易判反：我第一次就把右溢出写成了 `dr >= -0.5`，
     结果「文字比色块宽 2.66px」被判成「兜住了」，换成绝对坐标才看得出。
     纵向不能这么量——Range 的矩形给的是**行盒**高度，比色块高是常态，不代表字被切了。 */
  const inside = (g) => g.l >= tod.bl - 0.5 && g.r <= tod.br + 0.5;
  check('标注横向兜住日期文字（写死 20px 宽的圆点会让文字顶出去）',
    tod.found && tod.rects.length > 0 && tod.rects.every(inside),
    tod.found ? '文字「' + tod.text + '」/ 色块 x ' + tod.bl + '～' + tod.br +
      '（宽 ' + tod.w + '）/ 文字 x ' +
      tod.rects.map((g) => g.l + '～' + g.r + '（宽 ' + g.w + '）').join(' ') : 'n/a');
  const rad = parseFloat(tod.radius) || 0;
  check('标注是圆角矩形而不是圆（宽 > 高，圆角 < 半个高）',
    tod.found && tod.w > tod.h + 2 && rad > 0 && rad < tod.h / 2 - 1,
    tod.found ? tod.w + '×' + tod.h + 'px / border-radius ' + tod.radius : 'n/a');
  /* 标注的底色必须**就是**页面主色 --accent，不能在表头这里另写一份颜色。
     v1.9.12 把主色从通用蓝换成了品牌柚子绿，这条同时是「换主色有没有落到界面
     最显眼的那一处」的哨兵 —— 它以前是写死的蓝。 */
  const accentHex = await evalJs(
    'getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()');
  check('「今天」标注的底色就是页面主色 --accent（v1.9.12 起是品牌柚子绿 #3E7C2E）',
    tod.found && tod.bg === (await expectRgb(accentHex)),
    tod.bg + ' / --accent ' + accentHex);
  check('标注上是白字，且白字压主色的对比度 ≥ 4.5:1（主色身兼文字色，必须压得够深）',
    tod.found && tod.fg === 'rgb(255, 255, 255)' && contrastWhite(tod.bg) >= 4.5,
    tod.fg + ' 压 ' + tod.bg + ' = ' + contrastWhite(tod.bg).toFixed(2) + ':1');
  /* 最短（9/1）与最长（12/31）两个日期都得是矩形：前者靠 min-width、后者靠列宽。
     直接把文字换掉量一次真实宽度，比按字体估宽度靠得住。 */
  const span = JSON.parse(await evalJs(
    '(function(){var el=document.querySelector(".day-head.is-today .dd"),old=el.textContent,o={};' +
    '["9/1","12/31"].forEach(function(t){el.textContent=t;' +
    'var r=el.getBoundingClientRect();o[t]=[+r.width.toFixed(2),+r.height.toFixed(2)];});' +
    'el.textContent=old;return JSON.stringify(o);})()'));
  check('最短的日期（9/1）也仍是矩形：min-width 兜住，不会缩成方块',
    Math.abs(span['9/1'][0] - 26) <= 0.6 && span['9/1'][0] > span['9/1'][1] + 2,
    '9/1 → ' + span['9/1'][0] + '×' + span['9/1'][1] + 'px');
  check('最长的日期（12/31）撑不出所在天的列宽（窄屏 320dp 时列宽约 41px）',
    span['12/31'][0] <= tod.colW,
    '12/31 → ' + span['12/31'][0] + 'px / 列宽 ' + tod.colW + 'px（余 ' +
    +(tod.colW - span['12/31'][0]).toFixed(2) + 'px）');
  await shot(path.join(outDir, '图32-表头今天标注-v1.9.10.png'));
  await evalJs('(function(){var st=window.ScheduleApp.state;' +
    'st.viewWeek=window.__origWeek;delete window.__origWeek;' +
    'window.ScheduleApp.render();return 1;})()');
  await wait(300);

  /* ---- 品牌主色换装：整屏各留一张（v1.9.12）----
     主色与中性色是一起换的，只看单点（包边 / 表头那一小块）看不出「整屏是不是
     一套牌子」。这里在真实课表上取白天、夜晚各一屏。 */
  await shot(path.join(outDir, '图35-品牌柚子绿-白天-v1.9.12.png'));
  await evalJs('window.Store.setTheme("dark"); window.ScheduleApp.applyTheme(); 1');
  await wait(400);
  await shot(path.join(outDir, '图36-品牌柚子绿-夜晚-v1.9.12.png'));
  await evalJs('window.Store.setTheme("light"); window.ScheduleApp.applyTheme(); 1');
  await wait(300);

  /* ============================================================
     [19] 自绘选择器：月历 / 滚轮 / 单选列表（v1.9.15）
     ------------------------------------------------------------
     这一段放在最后：它会改「学期第一周的周一」，前面按周次算的断言
     不该被它影响。

     为什么非改不可：那四处原来弹的是**系统**画的层（<select> /
     <input type="date"> / <input type="time">），皮肤取自 Activity 主题
     （本工程 values-night 里是深色 Material），而应用自己的白天/夜晚是页面
     按 localStorage 定的 —— 两者可以不一致，「页面白天暖色 + 弹层一块冷灰」
     就是这么来的，CSS 一点改不动。换成自绘之后要证明三件事：
       ① 点开的是我们自己的层，且父层已经收起（弹层不许叠）；
       ② 层里的颜色绑在令牌上（不是又写死一份灰），两个主题都要对；
       ③ 选完能写回，取消 / 返回键 / 点弹层外都能退回父层。
     ============================================================ */
  console.log('\n[19] 自绘选择器：四处原生控件已换成应用内弹层（v1.9.15）');

  const pickOpen = () => evalJs('document.getElementById("maskPick").classList.contains("show")');
  const dateOpen = () => evalJs('document.getElementById("maskDate").classList.contains("show")');
  const timeOpen = () => evalJs('document.getElementById("maskTime").classList.contains("show")');
  const addOpen = () => evalJs('document.getElementById("maskAdd").classList.contains("show")');
  /* 按 data-* 找元素再点：不用属性选择器 —— 它得在生成的 JS 字符串里再套一层
     引号转义，而且读起来更绕（和上面 ttVal 那段注释同一个理由）。 */
  const clickByAttr = (sel, attr, val) => evalJs(
    '(function(){var r=document.querySelectorAll(' + JSON.stringify(sel) + ');' +
    'for(var i=0;i<r.length;i++){if(r[i].getAttribute(' + JSON.stringify(attr) + ')===' +
    JSON.stringify(val) + '){r[i].click();return true;}}return false;})()');
  const rowOn = (sel, attr, val) => evalJs(
    '(function(){var r=document.querySelectorAll(' + JSON.stringify(sel) + ');' +
    'for(var i=0;i<r.length;i++){if(r[i].getAttribute(' + JSON.stringify(attr) + ')===' +
    JSON.stringify(val) + ')return r[i].classList.contains("is-on");}return false;})()');
  const vroot = (n) => evalJs(
    'getComputedStyle(document.documentElement).getPropertyValue(' + JSON.stringify(n) + ').trim()');
  /* 那一周的周一（与 store.js 的 toMonday 同一条规则），用来核对月历那行提示 */
  const mondayOf = (iso) => {
    const p = String(iso).split('-').map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    const w = d.getDay();
    d.setDate(d.getDate() - (w === 0 ? 6 : w - 1));
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), wd: '星期' + '日一二三四五六'[d.getDay()] };
  };

  await evalJs('window.closeAllMasks();1');
  await wait(200);
  check('清场：此刻没有任何弹层', (await openCount()) === 0);

  /* ---- ① 月历：学期第一周的周一 ---- */
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(300);
  const startIso = String(await evalJs('document.getElementById("setStart").value'));
  const startTxt = String(await evalJs('document.getElementById("startDateText").textContent'));
  check('设置里那一行显示的是「年月日 + 星期」，不是光秃秃的 ISO',
    startTxt.indexOf('年') > 0 && /星期[一二三四五六日]/.test(startTxt), startTxt);
  await evalJs('document.getElementById("setStart").click();1');
  await wait(350);
  check('点那一行弹出的是自绘月历，设置那一层先收起（弹层不许叠）',
    (await dateOpen()) && !(await settingsOpen()));
  const calGeom = JSON.parse(await evalJs('JSON.stringify((function(){' +
    'var r=document.querySelectorAll("#calGrid .cal-d");' +
    'var tops={},cols={};' +
    'for(var i=0;i<r.length;i++){var b=r[i].getBoundingClientRect();' +
    'tops[Math.round(b.top)]=1;cols[Math.round(b.left)]=1;}' +
    'var a=r[0].getBoundingClientRect(), c=r[1].getBoundingClientRect();' +
    'var g=document.getElementById("calGrid").getBoundingClientRect();' +
    'return {n:r.length,rows:Object.keys(tops).length,cols:Object.keys(cols).length,' +
    'h:+a.height.toFixed(1),w:+a.width.toFixed(1),' +
    'gw:+g.width.toFixed(1),gh:+g.height.toFixed(1)};})())'));
  /* 判据用「等分铺满」而不是写死格子高宽：格高／列宽都是会变的（换字号、换屏宽都会动），
     真正不能变的是「7 列 6 行把网格铺满」—— 只有这才同时钉住「翻月高度不跳」。
     2px 是 .cal-grid 的 gap，与 CSS 同一处事实。 */
  check('月历排成 7 列 × 6 行共 42 格，且行列等分铺满（翻月时高度不会跳）',
    calGeom.n === 42 && calGeom.rows === 6 && calGeom.cols === 7 &&
    calGeom.h > 30 &&
    Math.abs(calGeom.w * 7 + 6 * 2 - calGeom.gw) <= 1 &&
    Math.abs(calGeom.h * 6 + 5 * 2 - calGeom.gh) <= 1,
    JSON.stringify(calGeom));
  check('月历表头是「周一开头」的七个字（周日不再排在第一个）',
    (await evalJs('document.querySelectorAll("#maskDate .cal-dow span").length')) === 7 &&
    (await evalJs('document.querySelectorAll("#maskDate .cal-dow span")[0].textContent')) === '一' &&
    (await evalJs('document.querySelectorAll("#maskDate .cal-dow span")[6].textContent')) === '日');
  const accentNow = await vroot('--accent');
  const onAccentNow = await vroot('--on-accent');
  const onDayStyle = String(await evalJs(
    '(function(){var e=document.querySelector("#calGrid .cal-d.is-on");' +
    'if(!e)return "";var s=getComputedStyle(e);return s.backgroundColor+"|"+s.color;})()'));
  check('选中的那天：底色就是 --accent、字色就是 --on-accent（没有另写一份绿）',
    onDayStyle === (await expectRgb(accentNow)) + '|' + (await expectRgb(onAccentNow)),
    onDayStyle + ' / --accent ' + accentNow);
  await shot(path.join(outDir, '图39-日期月历-v1.9.15.png'));

  /* 换一天：挑当月 15 号（当前值若是 15 号就挑 20 号）。
     月份跟着当前值走，所以这里不用自己算该显示哪个月。 */
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const targetDay = sd === 15 ? 20 : 15;
  const targetIso = sy + '-' + String(sm).padStart(2, '0') + '-' + String(targetDay).padStart(2, '0');
  const mon = mondayOf(targetIso);
  check('点得动某个日子，且下个月/上个月的箭头也在',
    (await clickByAttr('#calGrid .cal-d', 'data-d', targetIso)) === true);
  await wait(250);
  const pickedTxt = String(await evalJs('document.getElementById("calPicked").textContent'));
  const pickedWd = String(await evalJs('document.getElementById("calPickedWd").textContent'));
  const calNote = String(await evalJs('document.getElementById("calNote").textContent'));
  check('选中的日子大写显示出来（不只在格子里换底色）',
    pickedTxt === sm + '月' + targetDay + '日' &&
    pickedWd === '星期' + '日一二三四五六'[new Date(sy, sm - 1, targetDay).getDay()],
    pickedTxt + ' / ' + pickedWd);
  /* 保存时会自动对齐到周一，所以提示行必须**先把对齐结果说出来** ——
     否则用户点了周三、存进去变成周一，会以为是 bug。 */
  check('提示行把「会自动对齐到周一」的结果照实写出来',
    calNote === '这一周从 ' + mon.m + '月' + mon.d + '日（' + mon.wd + '）起算第 1 周', calNote);
  check('没点「设置」之前，设置页里的值一点没变（月历是草稿）',
    (await evalJs('document.getElementById("setStart").value')) === startIso);
  await evalJs('document.getElementById("calSave").click();1');
  await wait(350);
  const startTxt2 = String(await evalJs('document.getElementById("startDateText").textContent'));
  check('点「设置」把日子写回那一行，并退回设置页',
    (await settingsOpen()) && !(await dateOpen()) &&
    (await evalJs('document.getElementById("setStart").value')) === targetIso &&
    startTxt2.indexOf('年') > 0, startTxt2);

  /* ---- ② 滚轮：某一节的开始时间 ---- */
  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(350);
  const wStart0 = String(await ttVal(0, 'start'));
  await evalJs('(function(){var r=document.querySelectorAll("#ttList .tt-row")[0];' +
    'r.querySelectorAll(".tp")[0].click();})();1');
  await wait(350);
  check('点时间格弹出的是自绘滚轮，编辑时间表先收起（弹层不许叠）',
    (await timeOpen()) && !(await ttOpen()));
  const whl = JSON.parse(await evalJs('JSON.stringify((function(){' +
    'var h=document.getElementById("whlHour"), m=document.getElementById("whlMin");' +
    'var bh=h.querySelector(".whl-i.is-on"), bm=m.querySelector(".whl-i.is-on");' +
    'var band=document.querySelector("#maskTime .whl-band");' +
    'var br=band.getBoundingClientRect(), hr=bh.getBoundingClientRect(), mr=bm.getBoundingClientRect();' +
    'return {h:bh.getAttribute("data-i"),m:bm.getAttribute("data-i"),' +
    'bandTop:+br.top.toFixed(1),bandH:+br.height.toFixed(1),' +
    'hTop:+hr.top.toFixed(1),hH:+hr.height.toFixed(1),' +
    'mTop:+mr.top.toFixed(1),mH:+mr.height.toFixed(1),' +
    'bandBg:getComputedStyle(band).backgroundColor,' +
    'onColor:getComputedStyle(bh).color};})())'));
  check('滚轮已经滚到当前值那一项（正中那行才是选中的）',
    whl.h === String(Number(wStart0.slice(0, 2))) && whl.m === String(Number(wStart0.slice(3))),
    wStart0 + ' → ' + whl.h + ':' + whl.m);
  /* 「CSS 说得对但看不见」的经典形态：高亮带没对准正中那一行、或者被滚轮盖住。
     computed style 一点问题都看不出来，只能量位置 ——
     而且**比绝对坐标**（带子与那一行应当完全重合），不比差值。 */
  check('高亮带与正中那一行严丝合缝（上下边对齐、高度一致）',
    Math.abs(whl.bandTop - whl.hTop) <= 0.6 && Math.abs(whl.bandH - whl.hH) <= 0.6 &&
    Math.abs(whl.bandTop - whl.mTop) <= 0.6 && Math.abs(whl.bandH - whl.mH) <= 0.6,
    '带子 ' + whl.bandTop + '/' + whl.bandH + ' vs 时 ' + whl.hTop + '/' + whl.hH +
    ' 分 ' + whl.mTop + '/' + whl.mH);
  const softDay = await vroot('--accent-soft');
  check('高亮带的底色就是 --accent-soft，正中那项的字色就是 --accent',
    whl.bandBg === (await expectRgb(softDay)) && whl.onColor === (await expectRgb(accentNow)),
    whl.bandBg + ' / ' + whl.onColor);
  await shot(path.join(outDir, '图40-时间滚轮-v1.9.15.png'));
  /* 两个主题各量一次：白天写一处、两主题共用，是这套令牌最容易犯的错 */
  await evalJs('window.Store.setTheme("dark"); window.ScheduleApp.applyTheme(); 1');
  await wait(450);
  const softNight = await vroot('--accent-soft');
  const bandNight = String(await evalJs(
    'getComputedStyle(document.querySelector("#maskTime .whl-band")).backgroundColor'));
  check('滚轮高亮带在夜晚跟着令牌一起走（不是「写一处 = 两主题共用」）',
    bandNight === (await expectRgb(softNight)) && bandNight !== whl.bandBg,
    bandNight + ' / 夜晚 --accent-soft ' + softNight + '（白天是 ' + whl.bandBg + '）');
  await shot(path.join(outDir, '图41-时间滚轮-夜晚-v1.9.15.png'));
  await evalJs('window.Store.setTheme("light"); window.ScheduleApp.applyTheme(); 1');
  await wait(350);

  /* 滚到另一小时再确认：读数要跟着走，值要写回那一节 */
  const wMin = wStart0.slice(3);
  const wH2 = Number(wStart0.slice(0, 2)) === 9 ? 10 : 9;
  await evalJs('(function(){var b=document.getElementById("whlHour");' +
    'b.scrollTop=' + wH2 + '*Picker.WHEEL_H;b.dispatchEvent(new Event("scroll"));})();1');
  await wait(350);
  check('滚到哪一项，上方读数就跟着变（读数不是静态文字）',
    (await evalJs('document.getElementById("timeBig").textContent')) ===
    String(wH2).padStart(2, '0') + ':' + wMin);
  await evalJs('document.getElementById("timeSave").click();1');
  await wait(400);
  check('点「设置」把时间写回那一节，并退回编辑时间表',
    (await ttOpen()) && !(await timeOpen()) &&
    (await ttVal(0, 'start')) === String(wH2).padStart(2, '0') + ':' + wMin,
    wStart0 + ' → ' + (await ttVal(0, 'start')));
  /* 滚轮这一层的返回键：退回「编辑时间表」，不是一把掀回课表 */
  await evalJs('(function(){var r=document.querySelectorAll("#ttList .tt-row")[1];' +
    'r.querySelectorAll(".tp")[0].click();})();1');
  await wait(350);
  const backWhl = await evalJs('window.handleBack()');
  await wait(350);
  check('返回键：从滚轮退回「编辑时间表」（不是掀回课表）',
    backWhl === true && (await ttOpen()) && !(await timeOpen()));
  await evalJs('document.getElementById("ttBack").click();1');     // 丢掉这份草稿
  await wait(350);

  /* ---- ③ 单选列表：星期 ---- */
  await evalJs('document.getElementById("btnAdd").click();1');
  await wait(350);
  const day0 = String(await evalJs('document.getElementById("addDay").value'));
  const dayPick = day0 === '3' ? '5' : '3';
  await evalJs('document.getElementById("addDay").click();1');
  await wait(350);
  check('点「星期」弹出的是自绘单选列表（不再是原生 select 的系统列表）',
    (await pickOpen()) && !(await addOpen()));
  check('列表标题说清在选什么，当前值那行带 is-on（对勾靠它显示）',
    (await evalJs('document.getElementById("pickTitle").textContent')) === '星期' &&
    (await rowOn('#pickList .pick-row', 'data-v', day0)));
  const dayFit = await pickRowFit('pickList');
  check('星期那一行也完整落在列表可视区内（七个选项一屏装得下才谈得上「一眼看到」）',
    dayFit && dayFit.topOK && dayFit.botOK, JSON.stringify(dayFit));
  await shot(path.join(outDir, '图42-星期选择-v1.9.15.png'));
  await clickByAttr('#pickList .pick-row', 'data-v', dayPick);
  await wait(350);
  check('选完那一行文字跟着变，并退回添加课程（点一下即生效，不用再点确定）',
    (await evalJs('document.getElementById("addDay").value')) === dayPick &&
    (await evalJs('document.getElementById("addDayText").textContent')) ===
      '星期' + '一二三四五六日'[Number(dayPick) - 1] &&
    (await addOpen()));
  await evalJs('document.getElementById("btnAddClose").click();1');
  await wait(300);

  /* ---- ④ 单选列表：导入到哪个课表 ---- */
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(350);
  await evalJs('document.getElementById("importTarget").click();1');
  await wait(350);
  const pickRows = Number(await evalJs('document.querySelectorAll("#pickList .pick-row").length'));
  const schedCount = Number(await evalJs('window.Store.list().length'));
  check('「导入到哪个课表」弹出的是自绘列表，行数 = 课表数 + 1（末尾是「新建课表并导入」）',
    (await pickOpen()) && pickRows === schedCount + 1,
    pickRows + ' 行 / ' + schedCount + ' 个课表');
  /* 读的是这一行的「标题」和「副标题」两个元素，不是整行的 textContent ——
     整行还含标题前面的「＋」标记，拿整行去 indexOf(0) 等于把装饰当标题。 */
  const lastRow = 'document.querySelectorAll("#pickList .pick-row")[' + (pickRows - 1) + ']';
  check('最后一行是「新建课表并导入」，并顺带预告会用的名字',
    (await evalJs(lastRow + '.getAttribute("data-v")')) === '__new__' &&
    String(await evalJs(lastRow + '.querySelector(".pk-t").textContent'))
      .indexOf('新建课表并导入') >= 0 &&
    String(await evalJs(lastRow + '.querySelector(".pk-sub").textContent'))
      .indexOf('将命名为') === 0,
    String(await evalJs(lastRow + '.textContent')));
  await clickByAttr('#pickList .pick-row', 'data-v', '__new__');
  await wait(350);
  check('选完那一行跟着变，并退回导入弹层',
    (await evalJs('document.getElementById("importTarget").value')) === '__new__' &&
    (await evalJs('document.getElementById("importTargetText").textContent')) === '新建课表并导入' &&
    (await importOpen()));
  await evalJs('document.getElementById("btnImportClose").click();1');
  await wait(300);

  /* closeAllMasks 的遍历兜底天然覆盖新加的三层 —— 这里留一条回归哨兵：
     v1.8.3 那次漏了一层，返回键就被原生当成「已消费」吞掉，按下去毫无反应。 */
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(300);
  await evalJs('document.getElementById("setStart").click();1');
  await wait(350);
  check('新加的月历确实是打开着的（下面那条才有意义）', (await dateOpen()) === true);
  await evalJs('window.closeAllMasks();1');
  await wait(250);
  check('closeAllMasks 一趟遍历就覆盖到新加的三层（月历也一起关掉）',
    (await openCount()) === 0 && !(await dateOpen()), '剩下 ' + (await openCount()) + ' 层');

  /* ============================================================
     [20] 平板 / 宽屏（v1.9.16）
     ------------------------------------------------------------
     这一节是为了「同一个错不再犯第二次」。v1.9.15 的四处自绘控件都验过，
     可全都只在 390×844 上验 —— 于是「@media (min-width: 820px) 里那条
     .mask{align-items:center}（本意是让底部弹层在大屏上变成浮起的小卡片）
     把整页表单也一起居中了」这件事，一直到用户拿平板上手才被发现：
     .page 的高度是**内容撑出来的**（1112px > 视口 776px），一居中页顶就被
     推到屏幕上方 —— 页头跑出屏幕、右上角「固定上课时长」的开关落到
     y = -48 点不着、卡片标题被屏幕顶边切掉半行。

     所以要钉的不是「好不好看」，而是三条位置真理：
       ① 宽屏下整页依旧**铺满整个视口**（不居中、不缩成小卡片）；
       ② 页头里的东西（返回、开关）都完整落在**状态栏下方**且在屏幕内；
       ③ 回到手机视口一切照旧 —— 这是「不影响手机」的机器证明。
     ============================================================ */
  console.log('\n[20] 平板 / 宽屏适配（v1.9.16）');

  /* 量矩形用这一处实现，别在断言里各写各的（位置类断言比的是绝对坐标，
     所以统一 toFixed(1) 后按 1px 容差判，和自己比自己没有累积误差） */
  const rectOf = async (sel) => JSON.parse(await evalJs(
    'JSON.stringify((function(){var e=document.querySelector(' + JSON.stringify(sel) + ');' +
    'if(!e)return null;var b=e.getBoundingClientRect();' +
    'return {t:+b.top.toFixed(1),l:+b.left.toFixed(1),w:+b.width.toFixed(1),' +
    'h:+b.height.toFixed(1),b:+b.bottom.toFixed(1),r:+b.right.toFixed(1)};})())'));

  const TAB_W = 1072, TAB_H = 776, TAB_SAFE_TOP = 26;

  await send('Emulation.setDeviceMetricsOverride',
    { width: TAB_W, height: TAB_H, deviceScaleFactor: 2, mobile: false });
  /* 顺手把原生安全区桥接也桩上：不断言状态栏高度，就测不出「页头有没有让开它」。
     这里是运行期临时挂上、用完就摘（见本节末尾），所以前面那些按 --safe-top = 0
     算的像素断言一点不受影响。 */
  await evalJs('window.AndroidSafeArea={insets:function(){return ' +
    JSON.stringify(JSON.stringify({ top: TAB_SAFE_TOP, bottom: 48, left: 0, right: 0 })) + ';}};' +
    'window.__applySafeArea();1');
  await wait(450);
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(300);
  await evalJs('document.getElementById("btnTimes").click();1');
  await wait(420);

  const tMask = await rectOf('#maskTimetable');
  const tPage = await rectOf('#maskTimetable .page');
  const tHead = await rectOf('#maskTimetable .page-head');
  const tBack = await rectOf('#maskTimetable #ttBack');
  const tSw = await rectOf('#maskTimetable .switch');
  const tCard = await rectOf('#maskTimetable .page-body > .card');
  const tTimes = await rectOf('#maskTimetable .tt-row .tt-times');
  const tDoc = JSON.parse(await evalJs(
    'JSON.stringify({sw:document.documentElement.scrollWidth,vw:innerWidth})'));

  check('宽屏下整页仍铺满整个视口（页首贴在 0，不是被「居中」顶到屏幕外）',
    tMask.t === 0 && Math.abs(tMask.h - TAB_H) <= 0.5 &&
    tPage.t === 0 && Math.abs(tPage.h - TAB_H) <= 0.5,
    JSON.stringify({ mask: tMask, page: tPage }));
  check('页头横跨整屏（平板 app bar 的排法，不是一截 520px 的白条）',
    tHead.t === 0 && Math.abs(tHead.w - TAB_W) <= 0.5, JSON.stringify(tHead));
  check('返回按钮完整落在状态栏下方',
    tBack.t >= TAB_SAFE_TOP && tBack.b <= TAB_H, JSON.stringify({ tBack, TAB_SAFE_TOP }));
  check('「固定上课时长」的开关完整落在屏幕内且在状态栏下方（用户点不着的那一颗）',
    tSw.t >= TAB_SAFE_TOP && tSw.b <= TAB_H && tSw.r <= TAB_W, JSON.stringify(tSw));
  check('第一张卡片完整落在页头下方（标题不再被屏幕顶边切掉半行）',
    tCard.t >= tHead.b, JSON.stringify({ cardTop: tCard.t, headBottom: tHead.b }));
  check('内容列限宽 680 并水平居中（不把一行拉成 1000px 的长条）',
    tCard.w <= 680.5 && Math.abs(tCard.l - (TAB_W - tCard.w) / 2) <= 1, JSON.stringify(tCard));
  check('行内的值贴到右边（宽屏上不再留出四百像素的空白）',
    Math.abs(tTimes.r - (tCard.r - 14)) <= 1 && tTimes.l > tCard.l + tCard.w * 0.5,
    JSON.stringify({ times: tTimes, card: tCard }));
  check('宽屏下不产生横向滚动', tDoc.sw === tDoc.vw, JSON.stringify(tDoc));

  await shot(path.join(outDir, '图43-平板横屏-每节起止时间-v1.9.16.png'));

  /* ---- 回到手机视口：把桥接与安全区变量摘干净，证明手机端一行都没变 ---- */
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evalJs('delete window.AndroidSafeArea;' +
    'var st=document.documentElement.style;' +
    "st.removeProperty('--safe-top');st.removeProperty('--safe-bottom');" +
    "st.removeProperty('--safe-left');st.removeProperty('--safe-right');1");
  await wait(450);

  const pCard = await rectOf('#maskTimetable .page-body > .card');
  const pTimes = await rectOf('#maskTimetable .tt-row .tt-times');
  const pFlex = await evalJs(
    'getComputedStyle(document.querySelector("#maskTimetable .tt-row .cr-label")).flexGrow');

  check('回到手机视口：内容列重新铺满（左右各 12px 内边距，与 v1.9.15 一致）',
    Math.abs(pCard.w - (390 - 24)) <= 1 && Math.abs(pCard.l - 12) <= 1, JSON.stringify(pCard));
  check('回到手机视口：标签不再吃掉剩余空间，时间紧跟着标签（手机仍是挤着的排法）',
    pFlex === '0' && pTimes.l < 195, JSON.stringify({ flexGrow: pFlex, times: pTimes }));

  await evalJs('window.closeAllMasks();1');
  await wait(200);

  /* ============================================================
     [21] 桌面小组件的数据快照（v1.9.17）
     ------------------------------------------------------------
     小组件读不到 localStorage：它显示什么，全看页面推过去的这份快照。
     所以这里验的是「推了没有、推的东西对不对」——
     原生那半边的渲染由 smoke-test 的结构哨兵守着，真机上的样子由人看。
     ============================================================ */
  console.log('\n[21] 桌面小组件：页面推给原生的数据快照（v1.9.17）');

  const pushCount = await evalJs('window.__widgetPushes ? window.__widgetPushes.length : -1');
  check('页面把快照推给了原生（浏览器里没有这个桥，是测试桩接住的）',
    pushCount > 0, pushCount + ' 次');

  const snapRaw = await evalJs('window.__widgetPushes[window.__widgetPushes.length - 1]');
  let snap = null;
  try { snap = JSON.parse(snapRaw); } catch (e) { snap = null; }
  check('payload 是合法 JSON', !!snap, String(snapRaw).slice(0, 80));

  const curName = await evalJs('document.getElementById("curSchedName").textContent');
  check('带版本号与课表名（原生据此判断要不要重新解析）',
    !!snap && snap.v === 1 && snap.schedule === curName,
    snap ? snap.v + ' / ' + snap.schedule : 'null');

  const dayKeys = snap ? Object.keys(snap.days) : [];
  const today = await evalJs(
    '(function(){var d=new Date(),p=function(n){return n<10?"0"+n:""+n;};' +
    'return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());})()');
  check('覆盖 56 天', dayKeys.length === 56, dayKeys.length);
  check('含今天这一键（否则组件开箱就是「请打开柚课更新」）',
    dayKeys.indexOf(today) >= 0, today);

  const flat = [];
  dayKeys.forEach(function (k) { (snap.days[k] || []).forEach(function (c) { flat.push(c); }); });
  check('导入的课真的进了快照', flat.length > 0, flat.length + ' 条');
  check('每条都齐了原生要用的字段（名字 / 起止钟点 / 颜色）',
    flat.every(function (c) {
      return c && c.name && /^\d{2}:\d{2}$/.test(c.start) && /^\d{2}:\d{2}$/.test(c.end) &&
        /^#[0-9A-F]{6}$/i.test(c.color);
    }));

  /* 回课表对账，而不是钉死某门课（比如「高等数学A」）：
     这一整套 e2e 前后有增删改、切换课表，中途状态早不是刚导入的样子了，
     钉名字只会得到一条「换个顺序就红」的断言。
     真正要证明的是：**快照里的名字 / 地点 / 起止钟点，和课表页算出来的完全一致**
     —— 也就是「原生看到的」和「用户在网页上看到的」是同一份数据。 */
  const row0 = flat[0] || null;
  const srcRow = row0 ? JSON.parse(await evalJs(
    'JSON.stringify((function(){' +
    'var s=window.ScheduleApp.state,t=s.settings.times,hit=null;' +
    '(s.courses||[]).forEach(function(x){' +
    '  if(hit||x.name!==' + JSON.stringify(row0.name) + ')return;' +
    '  var a=(t[x.start-1]||{}).start||"",b=(t[x.end-1]||{}).end||"";' +
    '  if(a===' + JSON.stringify(row0.start) + '&&b===' + JSON.stringify(row0.end) + ')' +
    '    hit={name:x.name,loc:x.location||"",teacher:x.teacher||"",start:a,end:b};' +
    '});return hit;})())')) : null;

  check('快照里的课能对回课表：名字 / 起止钟点完全一致（节次真的按时间表换算过）',
    !!srcRow && srcRow.start === row0.start && srcRow.end === row0.end,
    row0 ? row0.name + ' ' + row0.start + '-' + row0.end + ' ←→ ' + JSON.stringify(srcRow) : '快照为空');
  check('地点原样带过去（组件上要能看出「去哪上」）',
    !!srcRow && srcRow.loc === row0.loc, row0 && (row0.loc + ' ←→ ' + (srcRow && srcRow.loc)));
  check('教师也一并带上（组件在没地点时可拿它兜底）',
    !!srcRow && row0.teacher === srcRow.teacher,
    row0 && (row0.teacher + ' ←→ ' + (srcRow && srcRow.teacher)));

  const sortedOk = dayKeys.every(function (k) {
    const list = snap.days[k] || [];
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].start > list[i].start) return false;
    }
    return true;
  });
  check('每天的课都按上课时间排好（组件第一项就是「接下来那一节」）', sortedOk);

  const sameShape = dayKeys.every(function (k) {
    const l = snap.days[k];
    return Array.isArray(l) && l.every(function (c) { return c && typeof c.name === 'string'; });
  });
  check('空的日子也给数组（原生靠「键在、值为空」区分没课与过期）', sameShape);

  console.log('\n[22] 分享课表 + 自绘确认框（v1.9.20）');
  /* 这一段量的是**矩形**和**真点下去的结果**，不是源码里有没有那几个字符串：
     挪按钮这种事，源码怎么读都对，真机上「一行放不下被挤出屏幕」才是常态。 */

  const barGeom = JSON.parse(await evalJs(
    '(function(){var g=function(id){var e=document.getElementById(id);if(!e)return null;' +
    'var r=e.getBoundingClientRect();return {l:+r.left.toFixed(2),r:+r.right.toFixed(2),' +
    't:+r.top.toFixed(2),b:+r.bottom.toFixed(2)};};' +
    'var box=function(s){var r=document.querySelector(s).getBoundingClientRect();' +
    'return {l:+r.left.toFixed(2),r:+r.right.toFixed(2)};};' +
    'return JSON.stringify({add:g("btnAdd"),share:g("btnShare"),theme:g("btnTheme"),' +
    'today:g("btnToday"),settings:g("btnSettings"),tb:box(".tb-actions"),wb:box(".weekbar"),' +
    'vw:document.documentElement.clientWidth});})()'));

  check('分享按钮落在顶栏那一排里、且完整在屏内（没被挤出去）',
    !!barGeom.share && barGeom.share.l >= barGeom.tb.l - 0.6 &&
    barGeom.share.r <= barGeom.tb.r + 0.6 && barGeom.share.r <= barGeom.vw + 0.6,
    JSON.stringify(barGeom.share) + ' / 顶栏 ' + JSON.stringify(barGeom.tb));
  check('分享按钮在「添加」右侧、「设置」左侧（顺序真的是 导入 / 添加 / 分享 / 设置）',
    barGeom.share.l >= barGeom.add.r - 0.6 && barGeom.share.r <= barGeom.settings.l + 0.6,
    JSON.stringify([barGeom.add, barGeom.share, barGeom.settings]));
  check('主题开关移到周次栏里、压在「本周」右侧，且和它同一行',
    !!barGeom.theme && !!barGeom.today &&
    barGeom.theme.l >= barGeom.wb.l - 0.6 && barGeom.theme.r <= barGeom.wb.r + 0.6 &&
    barGeom.theme.l >= barGeom.today.r - 0.6 &&
    Math.abs(barGeom.theme.t - barGeom.today.t) <= 6,
    JSON.stringify(barGeom.theme) + ' / 本周 ' + JSON.stringify(barGeom.today) +
      ' / 周次栏 ' + JSON.stringify(barGeom.wb));
  check('顶栏那一排没有因为多了分享而溢出（设置按钮仍在屏内）',
    barGeom.settings.r <= barGeom.vw + 0.6, barGeom.settings.r + ' / ' + barGeom.vw);

  /* 挪了位置，行为不能丢：点一下得真能换主题 */
  const themeBefore = await evalJs('document.documentElement.getAttribute("data-theme")');
  await evalJs('document.getElementById("btnTheme").click();1');
  await wait(240);
  const themeAfter = await evalJs('document.documentElement.getAttribute("data-theme")');
  check('挪到周次栏之后仍然能切换主题（月亮 / 太阳的状态没丢）',
    themeBefore !== themeAfter && (themeAfter === 'dark' || themeAfter === 'light'),
    themeBefore + ' -> ' + themeAfter);
  await evalJs('document.getElementById("btnTheme").click();1');   // 切回去，别影响后面的像素断言
  await wait(240);

  /* ---- 分享弹层：真点开、量两个选项的矩形 ---- */
  /* 切主题会弹一条 toast（1.9s），它正好落在弹层底部、会压住截图里的两个选项——
     等它自己消失再截图，否则图46 上「复制到剪贴板 / 保存为 CSV」被盖住一半。 */
  await wait(1900);
  const schedName = await evalJs('document.getElementById("curSchedName").textContent');
  await evalJs('document.getElementById("btnShare").click();1');
  await wait(280);
  const shareUi = JSON.parse(await evalJs(
    '(function(){var m=document.getElementById("maskShare"),s=m.querySelector(".sheet"),' +
    'r=s.getBoundingClientRect(),c=document.getElementById("btnShareCopy").getBoundingClientRect(),' +
    'v=document.getElementById("btnShareCsv").getBoundingClientRect();' +
    'return JSON.stringify({show:m.classList.contains("show"),' +
    'which:document.getElementById("shareWhich").textContent,' +
    'sum:document.getElementById("shareSummary").textContent,' +
    'copyH:+c.height.toFixed(2),csvH:+v.height.toFixed(2),' +
    'inView:r.top>=-0.6&&r.bottom<=innerHeight+0.6});})()'));
  check('点顶栏「分享」真的打开了分享弹层，两个选项都量得到（不是空壳）',
    shareUi.show === true && shareUi.copyH > 20 && shareUi.csvH > 20 && shareUi.inView,
    JSON.stringify(shareUi));
  check('弹层上写清了分享的是哪一张课表、有几门课',
    shareUi.which.indexOf(schedName) >= 0 && /\d+ 门课程/.test(shareUi.sum),
    shareUi.which + ' | ' + shareUi.sum);
  await shot(path.join(outDir, '图46-分享课表-v1.9.20.png'));

  /* ---- 复制到剪贴板 ---- */
  await evalJs('document.getElementById("btnShareCopy").click();1');
  await wait(260);
  const copied = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'share:document.getElementById("maskShare").classList.contains("show"),' +
    'toast:document.getElementById("toast").textContent});})()'));
  check('点「复制到剪贴板」后弹层收起，并给出明确反馈（不是悄无声息）',
    copied.share === false && /已复制|复制失败/.test(copied.toast), JSON.stringify(copied));

  /* ---- 保存 CSV：桩掉「下载」这一步，观察它到底把什么交给了浏览器 ----
     只断言「弹了个 toast」证明不了文件真的生成了；这里把 createObjectURL 与
     a.click 临时换成记录器，量的是**文件名、MIME、字节数**这三样。 */
  await evalJs(
    '(function(){window.__dl=null;window.__blob=null;' +
    'var oc=URL.createObjectURL;URL.createObjectURL=function(b){window.__blob=b;return "blob:youke-test";};' +
    'var c=HTMLAnchorElement.prototype.click;' +
    'HTMLAnchorElement.prototype.click=function(){window.__dl={name:this.download,href:this.href};};' +
    'window.__restoreDl=function(){URL.createObjectURL=oc;HTMLAnchorElement.prototype.click=c;};})();1');
  await evalJs('document.getElementById("btnShare").click();1');
  await wait(260);
  await evalJs('document.getElementById("btnShareCsv").click();1');
  await wait(260);
  const dl = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'name:window.__dl?window.__dl.name:null,href:window.__dl?window.__dl.href:null,' +
    'type:window.__blob?window.__blob.type:"",size:window.__blob?window.__blob.size:-1,' +
    'csvLen:new TextEncoder().encode(window.ScheduleApp.scheduleCsvText()).length,' +
    'share:document.getElementById("maskShare").classList.contains("show"),' +
    'toast:document.getElementById("toast").textContent});})()'));
  check('点「保存为 CSV」真的走到了落盘那一步（不是只弹个 toast）',
    !!dl.name && dl.href === 'blob:youke-test', JSON.stringify(dl));
  check('文件名带课表名与日期、扩展名是 .csv',
    /^柚课-.+-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.name || ''), dl.name);
  check('落盘的正是那份 CSV（字节数与 scheduleCsvText() 逐字节一致）',
    dl.size > 0 && dl.size === dl.csvLen, dl.size + ' / ' + dl.csvLen);
  check('MIME 声明成 text/csv（Excel / 系统认得出这是表格）',
    /^text\/csv/.test(dl.type), dl.type);
  check('存完弹层收起并告知已导出',
    dl.share === false && /已导出/.test(dl.toast), dl.toast);
  await evalJs('window.__restoreDl();1');

  /* ---- 发送到聊天：把课表当文件发出去（v1.9.21） ----
     无头浏览器里没有真原生桥，所以这里**注入一个记录器**当 AndroidShare：
     它把收到的四个参数原样留下，断言的是「点下去究竟把什么交给了系统」。
     真机上换成 ShareBridge，参数一个字都不用改。 */
  await wait(1900);   // 等「已导出」那条 toast 消失，别压住图48
  await evalJs(
    '(function(){window.__sent=null;window.AndroidShare={' +
    'hasApp:function(){return 1;},' +
    'shareFile:function(name,mime,text,target){' +
    'window.__sent={name:name,mime:mime,target:target,' +
    'len:new TextEncoder().encode(text).length,bom:text.charCodeAt(0)};return "ok:微信";}};})();1');
  await evalJs('document.getElementById("btnShare").click();1');
  await wait(260);
  await evalJs('document.getElementById("btnShareSend").click();1');
  await wait(260);
  const sendUi = JSON.parse(await evalJs(
    '(function(){var m=document.getElementById("maskSendTo"),s=m.querySelector(".sheet"),' +
    'r=s.getBoundingClientRect();' +
    'var rows=["btnSendWechat","btnSendQQ","btnSendDing","btnSendMore"].map(function(id){' +
    'var e=document.getElementById(id);return {id:id,h:+e.getBoundingClientRect().height.toFixed(2),' +
    'off:e.disabled};});' +
    'return JSON.stringify({show:m.classList.contains("show"),' +
    'share:document.getElementById("maskShare").classList.contains("show"),' +
    'what:document.getElementById("sendToWhat").textContent,rows:rows,' +
    'inView:r.top>=-0.6&&r.bottom<=innerHeight+0.6,bottom:+r.bottom.toFixed(2),vh:innerHeight});})()'));
  check('点「发送到聊天应用」进入转发层，且分享层同时被收掉（弹层不许叠）',
    sendUi.show === true && sendUi.share === false, JSON.stringify(sendUi));
  check('转发层四个选项都量得到、没有一个是灰的（桥上查得到安装状态）',
    sendUi.rows.length === 4 && sendUi.rows.every(function (x) { return x.h > 20 && !x.off; }),
    JSON.stringify(sendUi.rows));
  check('转发层完整落在屏内（多了两行也没把底部挤出屏幕）',
    sendUi.inView, sendUi.bottom + ' / ' + sendUi.vh);
  check('说明里写清了是哪张课表、以什么形式发',
    sendUi.what.indexOf(schedName) >= 0 && /\.csv/.test(sendUi.what), sendUi.what);
  await shot(path.join(outDir, '图48-发送到聊天-v1.9.21.png'));

  await evalJs('document.getElementById("btnSendWechat").click();1');
  await wait(260);
  const sent = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({sent:window.__sent,' +
    'csvLen:new TextEncoder().encode(window.ScheduleApp.scheduleCsvText()).length,' +
    'a:document.getElementById("maskSendTo").classList.contains("show"),' +
    'b:document.getElementById("maskShare").classList.contains("show"),' +
    'toast:document.getElementById("toast").textContent});})()'));
  check('点「微信」把真文件交给了桥：文件名 .csv、类型 text/csv、目标 wechat',
    !!sent.sent && /\.csv$/.test(sent.sent.name) &&
    sent.sent.mime === 'text/csv' && sent.sent.target === 'wechat',
    JSON.stringify(sent.sent));
  check('交出去的正是那份 CSV（带 BOM，字节数与 scheduleCsvText() 逐字节一致）',
    !!sent.sent && sent.sent.bom === 0xFEFF && sent.sent.len === sent.csvLen,
    sent.sent ? (sent.sent.bom + ' / ' + sent.sent.len + ' / ' + sent.csvLen) : '没送到');
  check('发出去之后两个弹层都收干净，并给出明确反馈',
    sent.a === false && sent.b === false && /已打开微信/.test(sent.toast), sent.toast);

  /* 没装的那个要就地置灰，而且不能连累别的 */
  await evalJs('window.AndroidShare.hasApp=function(t){return t==="qq"?0:1;};1');
  await evalJs('document.getElementById("btnShare").click();1');
  await wait(240);
  await evalJs('document.getElementById("btnShareSend").click();1');
  await wait(240);
  const greyed = JSON.parse(await evalJs(
    '(function(){var q=document.getElementById("btnSendQQ"),w=document.getElementById("btnSendWechat");' +
    'return JSON.stringify({qqOff:q.disabled,qqD:document.getElementById("sendQQD").textContent,' +
    'qqOpacity:getComputedStyle(q).opacity,wOff:w.disabled});})()'));
  check('没装 QQ：那一行就地置灰并说明原因，微信不受影响',
    greyed.qqOff === true && /没装QQ/.test(greyed.qqD) && greyed.wOff === false,
    JSON.stringify(greyed));
  check('置灰是真的看得出来（透明度降下来，不是只改了个属性）',
    parseFloat(greyed.qqOpacity) < 0.9, greyed.qqOpacity);

  await evalJs('document.getElementById("btnSendMore").click();1');
  await wait(240);
  const moreTarget = await evalJs('window.__sent?window.__sent.target:""');
  check('点「其他应用」把 target=other 交给原生（由它去弹系统分享面板）',
    moreTarget === 'other', moreTarget);

  /* 退出路径：取消 + 系统返回键，两个出口都必须**退回分享层**（不是一路掀回课表） */
  await evalJs('document.getElementById("btnShare").click();1');
  await wait(240);
  await evalJs('document.getElementById("btnShareSend").click();1');
  await wait(240);
  await evalJs('document.getElementById("btnSendCancel").click();1');
  await wait(240);
  const afterCancel = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'a:document.getElementById("maskSendTo").classList.contains("show"),' +
    'b:document.getElementById("maskShare").classList.contains("show")});})()'));
  check('点「取消」退回分享层（不是直接扔回课表）',
    afterCancel.a === false && afterCancel.b === true, JSON.stringify(afterCancel));

  await evalJs('document.getElementById("btnShareSend").click();1');
  await wait(240);
  await evalJs('window.handleBack();1');
  await wait(240);
  const afterBack = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'a:document.getElementById("maskSendTo").classList.contains("show"),' +
    'b:document.getElementById("maskShare").classList.contains("show")});})()'));
  check('系统返回键走的是同一条路（BULLET_BACK 登记过才不会被当成「已消费」吞掉）',
    afterBack.a === false && afterBack.b === true, JSON.stringify(afterBack));
  await evalJs('document.getElementById("btnShareCancel").click();1');
  await wait(200);
  const clearedShare = await evalJs(
    'document.querySelectorAll(".mask.show").length');
  check('清场：分享链路走完之后一个弹层都不剩（后面几段才有干净的起点）',
    clearedShare === 0, clearedShare);
  await evalJs('delete window.AndroidShare;1');

  /* ---- 自绘确认框：三个出口（取消 / 系统返回键 / 确定）行为一致 ---- */
  await wait(1900);   // 同上：等「已导出」那条 toast 消失，别压住图47 的底部
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(260);
  const beforeClear = await evalJs('window.ScheduleApp.state.courses.length');
  check('清空前课表里确实有课（否则下面几条会假绿）', beforeClear > 0, beforeClear);

  await evalJs('document.getElementById("btnClear").click();1');
  await wait(280);
  const cf = JSON.parse(await evalJs(
    '(function(){var m=document.getElementById("maskConfirm"),s=m.querySelector(".sheet"),' +
    'r=s.getBoundingClientRect(),ok=document.getElementById("confirmOk");' +
    'return JSON.stringify({show:m.classList.contains("show"),' +
    'title:document.getElementById("confirmTitle").textContent,' +
    'msg:document.getElementById("confirmMsg").textContent,ok:ok.textContent,' +
    'okCls:ok.className,centerDX:+Math.abs((r.left+r.right)/2-innerWidth/2).toFixed(2),' +
    'settings:document.getElementById("maskSettings").classList.contains("show"),' +
    'inView:r.top>=-0.6&&r.bottom<=innerHeight+0.6});})()'));
  check('点「清空当前课表」弹出的是应用内自绘确认框，而不是系统对话框',
    cf.show === true, JSON.stringify(cf));
  check('确认框是居中小窗、完整落在视口内（不是贴底整条面板）',
    cf.centerDX <= 1 && cf.inView, cf.centerDX + ' / ' + cf.inView);
  check('确认框写清了动作与后果，确定按钮是破坏性样式',
    cf.title === '清空课表' && /可撤销/.test(cf.msg) &&
    cf.msg.indexOf(beforeClear + ' 门课程') >= 0 &&
    cf.ok === '清空' && /btn-danger/.test(cf.okCls),
    cf.title + ' | ' + cf.msg.replace(/\n/g, '⏎').slice(0, 50) + ' | ' + cf.okCls);
  check('打开确认框时父层被收掉（弹层不许叠）', cf.settings === false);
  await shot(path.join(outDir, '图47-清空课表确认框-v1.9.20.png'));

  const readClearState = async () => JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'confirm:document.getElementById("maskConfirm").classList.contains("show"),' +
    'settings:document.getElementById("maskSettings").classList.contains("show"),' +
    'n:window.ScheduleApp.state.courses.length,' +
    'cards:document.querySelectorAll(".course").length});})()'));

  await evalJs('document.getElementById("confirmCancel").click();1');
  await wait(260);
  const cancelled = await readClearState();
  check('出口一「取消」：课程一门没少、确认框收起、退回设置那一层（上下文不丢）',
    cancelled.confirm === false && cancelled.settings === true && cancelled.n === beforeClear,
    JSON.stringify(cancelled));

  await evalJs('document.getElementById("btnClear").click();1');
  await wait(260);
  const backRet = await evalJs('window.handleBack()');
  await wait(260);
  const backed = await readClearState();
  check('出口二「系统返回键」：与取消完全一致（退回设置、课程一门没少）',
    backRet === true && backed.confirm === false && backed.settings === true &&
    backed.n === beforeClear, backRet + ' / ' + JSON.stringify(backed));

  await evalJs('document.getElementById("btnClear").click();1');
  await wait(260);
  await evalJs('document.getElementById("confirmOk").click();1');
  await wait(340);
  const cleared = await readClearState();
  const clearToast = await evalJs('document.getElementById("toast").textContent');
  check('出口三「确定」：课程真的清空了、卡片也全没了、并退回设置（看得见结果）',
    cleared.confirm === false && cleared.settings === true &&
    cleared.n === 0 && cleared.cards === 0 && /已清空/.test(clearToast),
    JSON.stringify(cleared) + ' / ' + clearToast);

  /* ============================================================
     [22] C 批（v1.9.28）：数据可靠性三条出口，真跑一遍
     ------------------------------------------------------------
     smoke 里那几条是「切出函数体读源码」＋「直接调纯函数」；
     这里补的是**从界面点下去**的那一遍：调小节数会不会先问、
     节次越界会不会报错、坏 CSV 会不会说清原因。
     ============================================================ */
  console.log('\n[22] C 批：调小节数要问、节次越界要报、坏 CSV 要说清');
  await wait(1900);   // 等上一条 toast 消失，免得读到的是「已清空」

  /* --- C-2 调小「每天节数」必须先问一句 --- */
  await evalJs('document.getElementById("btnSettings").click();1');
  await wait(280);
  const secBefore = await evalJs('window.ScheduleApp.state.settings.sections');
  const timesBefore = await evalJs('window.ScheduleApp.state.settings.times.length');
  check('前提：每天节数与时间表等长且够长（否则下面量不出截断）',
    secBefore >= 3 && timesBefore === secBefore, secBefore + ' / ' + timesBefore);

  await evalJs('(function(){var el=document.getElementById("setSections");' +
    'el.value="' + (secBefore - 2) + '";' +
    'el.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await evalJs('document.getElementById("btnSaveSettings").click();1');
  await wait(320);
  const secDlg = JSON.parse(await evalJs(
    '(function(){var m=document.getElementById("maskConfirm");' +
    'return JSON.stringify({show:m.classList.contains("show"),' +
    'title:document.getElementById("confirmTitle").textContent,' +
    'msg:document.getElementById("confirmMsg").textContent,' +
    'ok:document.getElementById("confirmOk").textContent});})()'));
  check('调小「每天节数」先弹应用内确认框（不是静默把尾部时间砍掉）',
    secDlg.show === true, JSON.stringify(secDlg));
  check('确认框标题写明是「调小每天节数」，不是那个通用的「确认」',
    secDlg.title === '调小每天节数', secDlg.title);
  check('确认框说清「第几节起、丢几条」并标明不可撤销',
    /第\s*\d+\s*节起/.test(secDlg.msg) && /共\s*\d+\s*条时间设置/.test(secDlg.msg) &&
    /不可撤销/.test(secDlg.msg), secDlg.msg.replace(/\n/g, '⏎').slice(0, 70));

  await evalJs('document.getElementById("confirmCancel").click();1');
  await wait(320);
  const afterCancelSec = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'sections:window.ScheduleApp.state.settings.sections,' +
    'times:window.ScheduleApp.state.settings.times.length,' +
    'confirm:document.getElementById("maskConfirm").classList.contains("show"),' +
    'settings:document.getElementById("maskSettings").classList.contains("show")});})()'));
  check('点「取消」：节数与时间表一个字没动（不是先改了再问）',
    afterCancelSec.sections === secBefore && afterCancelSec.times === timesBefore,
    JSON.stringify(afterCancelSec));
  check('点「取消」退回设置那一层（上下文不丢）',
    afterCancelSec.confirm === false && afterCancelSec.settings === true,
    JSON.stringify(afterCancelSec));

  await evalJs('document.getElementById("btnSaveSettings").click();1');
  await wait(320);
  await evalJs('document.getElementById("confirmOk").click();1');
  await wait(420);
  const afterOkSec = JSON.parse(await evalJs(
    '(function(){var raw=localStorage.getItem(window.Store.KEY),st=null;' +
    'try{st=JSON.parse(raw);}catch(e){st=null;}' +
    'var act=(st&&st.schedules||[]).filter(function(s){return s.id===window.Store.state.activeId})[0];' +
    'return JSON.stringify({' +
    'sections:window.ScheduleApp.state.settings.sections,' +
    'times:window.ScheduleApp.state.settings.times.length,' +
    'stored:act?act.settings.sections:null});})()'));
  check('点「继续」：节数与时间表一起变短，并且真的落到了本机存储',
    afterOkSec.sections === secBefore - 2 && afterOkSec.times === secBefore - 2 &&
    afterOkSec.stored === secBefore - 2, JSON.stringify(afterOkSec));

  /* --- C-5 节次越界要报错，而不是存下一门看不见的课 --- */
  const c5Sec = await evalJs('window.ScheduleApp.state.settings.sections');
  const c5Before = await evalJs('window.ScheduleApp.state.courses.length');
  await evalJs('document.getElementById("btnAdd").click();1');
  await wait(320);
  await evalJs('(function(){' +
    'document.getElementById("addName").value="越界探针课";' +
    'document.getElementById("addDay").value="7";' +
    'document.getElementById("addStart").value="1";' +
    'document.getElementById("addEnd").value="' + (c5Sec + 3) + '";' +
    'document.getElementById("addWeeks").value="1-16";return 1;})()');
  await evalJs('document.getElementById("btnAddSave").click();1');
  await wait(320);
  const c5 = JSON.parse(await evalJs(
    '(function(){return JSON.stringify({' +
    'n:window.ScheduleApp.state.courses.length,' +
    'form:document.getElementById("maskAdd").classList.contains("show"),' +
    'toast:document.getElementById("toast").textContent});})()'));
  check('节次超过当前每天节数时明确报错（不是悄悄存下一门看不见的课）',
    c5.n === c5Before && /节次要在/.test(c5.toast), JSON.stringify(c5));
  check('报错文案带上「当前每天几节」，用户知道去哪改',
    new RegExp('1 ~ ' + c5Sec).test(c5.toast) && /设置/.test(c5.toast), c5.toast);
  check('报错后表单还开着（用户直接改一下就能存，不用重填）', c5.form === true);
  await evalJs('document.getElementById("btnAddClose").click();1');
  await wait(260);

  /* --- C-3 未闭合引号要指名报错，不是含糊的「0 门课程」 --- */
  await wait(1900);
  await evalJs('document.getElementById("btnImport").click();1');
  await wait(320);
  const c3Before = await evalJs('window.ScheduleApp.state.courses.length');
  await evalJs('(function(){var t=document.getElementById("pasteArea");' +
    't.value="课程名称,星期,开始节数,结束节数,老师,地点,周数\\n' +
    '\\"高等数学A,一,1,2,李明,明理(5)-401,1-16周\\n";' +
    't.dispatchEvent(new Event("input",{bubbles:true}));return 1;})()');
  await evalJs('document.getElementById("btnImportPaste").click();1');
  await wait(520);
  const c3 = await evalJs('document.getElementById("importResult").innerText');
  check('未闭合引号的 CSV 被指名报出来（不是含糊的「0 门课程」）',
    /引号未闭合/.test(c3), c3.replace(/\n/g, ' / ').slice(0, 130));
  check('报错里带行号，用户知道去改哪一行',
    /第\s*2\s*行/.test(c3), c3.replace(/\n/g, ' / ').slice(0, 130));
  check('报错没有把好文件也一棍子打死（仍然给出「0 门课程」以外的信息）',
    /格式有误/.test(c3), c3.replace(/\n/g, ' / ').slice(0, 130));
  check('坏文件没被倒进课表（解析失败就只是预览，不落库）',
    (await evalJs('window.ScheduleApp.state.courses.length')) === c3Before,
    c3Before + ' → ' + (await evalJs('window.ScheduleApp.state.courses.length')));
  await evalJs('window.closeAllMasks();1');
  await wait(240);
  const c3Clean = await evalJs('document.querySelectorAll(".mask.show").length');
  check('清场：C 批这三段走完一个弹层都不剩', c3Clean === 0, String(c3Clean));

  runFinished = true;   // 出口哨兵：跑到这儿才算「跑完」
  console.log('\n============================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  ws.close();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  /* 也要打一条带名字的 ✘ —— 下游只认 ✘ 行，只打一行「失败」等于没红。 */
  console.log('  ✘ 端到端测试中途抛出（脚本没跑完，上面的通过数不代表全貌）');
  console.error('端到端测试失败：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
}).finally(() => {
  if (child && !child.killed) { try { child.kill(); } catch (e) {} }
  setTimeout(() => {
    /* 收尾删掉自己这份临时 profile。Chrome 被 kill 之后文件句柄要过一会儿才放开，
       删不掉就算了（force + try）。顺手再收 2 个前几次留下的（限量，别让收尾也变慢）。 */
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    try { sweepOldProfiles(2); } catch (e) {}
    process.exit(process.exitCode || 0);
  }, 1200);
});
