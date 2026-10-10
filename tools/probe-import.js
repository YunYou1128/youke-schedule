(async function () {
  var out = [];
  function dayName(d) { return '一二三四五六日'.charAt(d - 1); }
  var files = ['sched.xls', 'sched.xlsx', 'sched.pdf', '大三上.csv', '示例课表.csv', 'fake.csv'];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    try {
      var resp = await fetch(f);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var ab = await resp.arrayBuffer();
      var parsed = await ImportUtil.parseBuffer(ab, f, ScheduleApp.state.settings);
      out.push({
        file: f,
        bytes: ab.byteLength,
        sniffed: ImportUtil.sniff(new Uint8Array(ab)),
        format: parsed.format,
        source: parsed.source,
        count: parsed.courses.length,
        parsed: parsed.stats.parsed,
        merged: parsed.stats.merged,
        dup: parsed.stats.duplicate,
        suggestWeek: parsed.suggestTotalWeeks,
        errors: parsed.errors,
        notes: parsed.notes,
        sample: parsed.courses.slice(0, 2).map(function (c) {
          return '周' + dayName(c.day) + ' ' + c.start + '-' + c.end + '节 ' + c.name + ' @' + c.location + ' ' + c.teacher + ' [' + c.weeksText + ']';
        }),
        weeks: parsed.courses[0] ? parsed.courses[0].weeks.join(',') : null
      });
    } catch (e) {
      out.push({ file: f, error: String((e && e.message) || e) });
    }
  }
  /* 真实导入一次，验证渲染 */
  try {
    var r2 = await fetch('sched.pdf');
    var res = await ImportUtil.parseBuffer(await r2.arrayBuffer(), 'sched.pdf', ScheduleApp.state.settings);
    ScheduleApp.state.courses = res.courses;
    ScheduleApp.state.settings.totalWeeks = Math.max(ScheduleApp.state.settings.totalWeeks, res.suggestTotalWeeks || 0);
    Store.save();
    ScheduleApp.render();
    await new Promise(function (z) { setTimeout(z, 300); });
    out.push({
      renderCheck: '卡片数=' + document.querySelectorAll('.course').length +
        ' 首格=' + (document.querySelector('.course') ? document.querySelector('.course').textContent.trim() : '—') +
        ' 第几周=' + document.getElementById('weekText').textContent
    });
  } catch (e) {
    out.push({ renderCheck: 'ERR ' + ((e && e.message) || e) });
  }
  return JSON.stringify(out, null, 1);
})()
