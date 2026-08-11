/*
 * export.js — 엑셀(.xlsx)과 이미지 내보내기.
 *
 * 엑셀 라이브러리를 쓰지 않고 직접 만든다. 필요한 것이 '쓰기'뿐인데
 * 흔히 쓰는 라이브러리는 900KB에 파싱 쪽 취약점 이력이 있어, 읽지도 않을
 * 코드를 사용자 브라우저에 올릴 이유가 없다. xlsx 는 XML 몇 장을 zip 으로
 * 묶은 형식이고, zip 은 무압축(store) 방식이 규격상 유효하므로
 * 압축 알고리즘 없이 만들 수 있다.
 *
 * 내보내는 파일에는 조회조건 시트를 반드시 넣는다. 어느 지역·연도·회계범위를
 * 어떤 단위로 본 값인지가 함께 있어야 나중에 인용할 수 있다.
 */
(function (global) {
  'use strict';

  const XLSX = {};

  // ── CRC32 ───────────────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();

  // ── zip (store) ─────────────────────────────────────────
  function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    // 재현 가능한 파일을 위해 고정 타임스탬프를 쓴다.
    const dosTime = 0, dosDate = (2020 - 1980) << 9 | 1 << 5 | 1;

    files.forEach(({ name, data }) => {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);            // version needed
      lv.setUint16(6, 0x0800, true);        // UTF-8 파일명
      lv.setUint16(8, 0, true);             // store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);            // version made by
      cv.setUint16(6, 20, true);            // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);            // extra
      cv.setUint16(32, 0, true);            // comment
      cv.setUint16(34, 0, true);            // disk
      cv.setUint16(36, 0, true);            // internal attrs
      cv.setUint32(38, 0, true);            // external attrs
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + data.length;
    });

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...parts, ...central, eocd],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ── XML ─────────────────────────────────────────────────
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      // 엑셀이 거부하는 제어문자를 미리 걸러낸다
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colName(i) {
    let s = '';
    i += 1;
    while (i > 0) {
      const r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function sheetXml(rows) {
    const out = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
    ];
    rows.forEach((row, r) => {
      out.push(`<row r="${r + 1}">`);
      row.forEach((cell, c) => {
        if (cell === null || cell === undefined || cell === '') return;
        const ref = `${colName(c)}${r + 1}`;
        if (typeof cell === 'number' && isFinite(cell)) {
          out.push(`<c r="${ref}"><v>${cell}</v></c>`);
        } else {
          out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`);
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData></worksheet>');
    return enc.encode(out.join(''));
  }

  /** 엑셀 시트명 제약: 31자 이하, []:*?/\ 금지, 중복 불가 */
  function safeSheetName(name, used) {
    let n = String(name).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let base = n, i = 2;
    while (used.has(n)) {
      const suffix = `(${i++})`;
      n = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(n);
    return n;
  }

  /**
   * 통합문서를 만든다.
   * @param sheets [{ name, rows: [][] }]
   */
  XLSX.build = function (sheets) {
    const used = new Set();
    const named = sheets.map(s => ({ ...s, name: safeSheetName(s.name, used) }));

    const files = [];
    const types = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ];
    const wbSheets = [];
    const wbRels = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ];

    named.forEach((s, i) => {
      const n = i + 1;
      files.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheetXml(s.rows) });
      types.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      wbSheets.push(`<sheet name="${esc(s.name)}" sheetId="${n}" r:id="rId${n}"/>`);
      wbRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
    });

    types.push('</Types>');
    wbRels.push('</Relationships>');

    files.unshift(
      { name: '[Content_Types].xml', data: enc.encode(types.join('')) },
      {
        name: '_rels/.rels',
        data: enc.encode(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>'),
      },
      {
        name: 'xl/workbook.xml',
        data: enc.encode(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets>${wbSheets.join('')}</sheets></workbook>`),
      },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels.join('')) },
    );

    return zip(files);
  };

  XLSX.download = function (sheets, filename) {
    const blob = XLSX.build(sheets);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ── 조회조건 시트 ────────────────────────────────────────
  /**
   * 모든 내보내기에 붙는 첫 시트.
   * 출처와 기준일, 수집 완전성까지 담아야 이 숫자를 보고서에 쓸 수 있다.
   */
  XLSX.conditionSheet = function (ctx) {
    const rows = [
      ['조회조건'],
      [],
      ['항목', '값'],
      ['지역', ctx.regionLabel || ''],
      ['비교지역', (ctx.compareLabels || []).join(', ') || '없음'],
      ['연도', ctx.yearLabel || ''],
      ['분야·부문', ctx.scopeLabel || ''],
      ['회계 범위', ctx.accountLabel || ''],
      ['단위', ctx.unitLabel || ''],
    ];
    if (ctx.denominatorLabel) rows.push(['비중 분모', ctx.denominatorLabel]);
    rows.push(
      [],
      ['출처', ctx.source || ''],
      ['기준', ctx.basis || ''],
      ['데이터 생성', ctx.builtAt || ''],
      ['내보낸 시각', new Date().toLocaleString('ko-KR')],
    );
    if (ctx.completeness && ctx.completeness.length) {
      rows.push([], ['연도', '수집 건수', '전체 건수', '수집률']);
      ctx.completeness.forEach(c => rows.push([
        c.y, c.rows ?? '', c.total ?? '',
        c.rate != null ? `${(c.rate * 100).toFixed(2)}%` : '',
      ]));
    }
    if (ctx.warnings && ctx.warnings.length) {
      rows.push([], ['경고']);
      ctx.warnings.forEach(w => rows.push([w]));
    }
    return { name: '조회조건', rows };
  };

  // ── 이미지 ──────────────────────────────────────────────
  /**
   * 차트를 이미지로 저장한다.
   * 배율을 3배로 두는 것은 보고서에 넣었을 때 글자가 뭉개지지 않게 하려는 것이다.
   */
  XLSX.downloadImage = function (gd, filename, format) {
    return Plotly.downloadImage(gd, {
      format: format || 'png',
      filename: filename,
      scale: format === 'svg' ? 1 : 3,
      width: gd.clientWidth || 1000,
      height: gd.clientHeight || 560,
    });
  };

  global.XLSXOut = XLSX;
})(window);
