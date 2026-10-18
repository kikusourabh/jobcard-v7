const PDFDocument = require('pdfkit');

// ---- page: 105 x 150 mm -----------------------------------------------------
const MM = 72 / 25.4;
const mm = (v) => v * MM;
const PAGE_W = 105, PAGE_H = 150, M = 3; // margin in mm
const W = PAGE_W - 2 * M;                // 99 mm usable width

const RED = '#d11a1a', GREEN = '#1c7c1c', BLACK = '#000000', LINE = '#444444';

// Labels exactly as printed on the original sheet (edit spellings here if you like)
const L = {
  instruction: 'Instruction', repairing: 'Reparing', diamond: 'Daimond / Packet No',
};

// Everything needed to re-open a card for editing is stored inside the PDF itself
// (as hidden embedded files), so a generated PDF can be uploaded and edited later.
const FIELDS = ['pno', 'category', 'cname', 'odate', 'ddate', 'karat', 'color', 'size',
  'apxWtg', 'cadFile', 'quantity', 'rpt', 'casting', 'instruction', 'fileName'];

function embedEditData(doc, d, imgs) {
  const payload = { app: 'jobcard', version: 1, fields: {} };
  FIELDS.forEach((k) => { payload.fields[k] = d[k] || ''; });
  doc.file(Buffer.from(JSON.stringify(payload), 'utf8'), { name: 'jobcard-data.json', type: 'application/json' });
  if (imgs.designImage) doc.file(imgs.designImage, { name: 'design.jpg', type: 'image/jpeg' });
  if (imgs.diamondImage) doc.file(imgs.diamondImage, { name: 'diamond.jpg', type: 'image/jpeg' });
}

function fmtDate(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

function buildJobCard(d = {}, imgs = {}) {
  const doc = new PDFDocument({ size: [mm(PAGE_W), mm(PAGE_H)], margin: 0, info: { Title: `Job Card ${d.pno || ''}` } });
  doc.lineWidth(0.5).strokeColor(LINE);

  // draw a bordered cell (all values in mm)
  function cell(x, y, w, h, text = '', o = {}) {
    doc.rect(mm(x), mm(y), mm(w), mm(h)).stroke();
    if (!text) return;
    const size = o.size || 6.2;
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(o.color || BLACK);
    const th = doc.currentLineHeight();
    doc.text(String(text), mm(x) + 2, mm(y) + (mm(h) - th) / 2 + 0.3, {
      width: mm(w) - 4, align: o.align || 'left', lineBreak: false, ellipsis: true,
    });
  }

  // ---- 1. images (design left, diamond details right) -------------------------
  const imgY = M, imgH = 37;
  const place = (buf, x, w) => {
    if (!buf) return;
    doc.image(buf, mm(x), mm(imgY), { fit: [mm(w), mm(imgH)], align: 'center', valign: 'center' });
  };
  place(imgs.designImage, M, 48);
  place(imgs.diamondImage, M + 51, 48);

  // ---- 2. header info block -----------------------------------------------------
  const y0 = imgY + imgH + 1, rh = 3.8;
  // label / value columns line up with the Process | Date columns of the table below (14 + 12)
  const cw = [14, 12, 36, 17, 20];
  const cx = [M]; cw.forEach((w, i) => cx.push(cx[i] + w));
  const left = [
    ['P no', d.pno, BLACK], ['O date', fmtDate(d.odate), RED], ['D date', fmtDate(d.ddate), RED],
    ['karat', d.karat, BLACK], ['Color', d.color, BLACK], ['Size', d.size, RED],
  ];
  const right = [
    ['C name', d.cname, BLACK, false], ['Apx WTG', d.apxWtg, RED, true], ['Cad File', d.cadFile, BLACK, false],
    ['quntity', d.quantity, BLACK, false], ['RPT', d.rpt, BLACK, false], ['Casting', d.casting, BLACK, false],
  ];
  left.forEach(([lab, val, col], i) => {
    const y = y0 + i * rh;
    cell(cx[0], y, cw[0], rh, lab, { color: col, bold: col === RED });
    cell(cx[1], y, cw[1], rh, val, { align: 'center', size: lab.includes('date') ? 5.6 : undefined });
  });
  right.forEach(([lab, val, col, bold], i) => {
    const y = y0 + i * rh;
    cell(cx[3], y, cw[3], rh, lab, { color: col, bold });
    cell(cx[4], y, cw[4], rh, val, { align: 'center' });
  });
  // instruction box (merged)
  cell(cx[2], y0, cw[2], rh * 6);
  doc.font('Helvetica').fontSize(6.5).fillColor(BLACK)
    .text(L.instruction, mm(cx[2]), mm(y0) + 2, { width: mm(cw[2]), align: 'center', lineBreak: false });
  if (d.instruction) {
    doc.fontSize(5.8).text(d.instruction, mm(cx[2]) + 2, mm(y0 + rh) + 1, {
      width: mm(cw[2]) - 4, height: mm(rh * 5) - 3, ellipsis: true,
    });
  }

  // ---- 3. process table + repairing ------------------------------------------------
  const py = y0 + rh * 6, ph = 3.5;
  const pw = [14, 12, 12, 12, 12];                 // Process Date Issue return Worker
  const rw = [12, 12, 13];                         // repairing: worker Issue return
  const px = [M]; pw.forEach((w, i) => px.push(px[i] + w));
  const rx = [px[5]]; rw.forEach((w, i) => rx.push(rx[i] + w));

  ['Process', 'Date', 'Issue', 'return', 'Worker'].forEach((t, i) =>
    cell(px[i], py, pw[i], ph, t, { color: i === 1 ? RED : BLACK, bold: i <= 1, align: i === 0 ? 'left' : 'center' }));
  cell(rx[0], py, W - (rx[0] - M), ph, L.repairing, { align: 'center' });

  const procs = ['Filling', 'Filling', 'Ex gold', 'Ex gold', 'P Pol', 'P Pol', 'setting', 'setting', 'F Pol', 'F Pol', 'Qc', 'Qc'];
  procs.forEach((p, r) => {
    const y = py + ph * (r + 1);
    pw.forEach((w, i) => cell(px[i], y, w, ph, i === 0 ? p : '', { color: GREEN, bold: true }));
    rw.forEach((w, i) => cell(rx[i], y, w, ph));
  });
  // repairing sub-header on first process row
  ['worker', 'Issue', 'return'].forEach((t, i) => cell(rx[i], py + ph, rw[i], ph, t, { align: 'center' }));
  // CTG block (rows 11..15 of the right panel)
  const cr = (n) => py + ph * n;
  cell(rx[0], cr(11), rw[0], ph, 'CTG', { color: RED, bold: true, align: 'center' });
  cell(rx[1], cr(11), rw[1], ph, 'Qty', { color: RED, bold: true, align: 'center' });
  cell(rx[2], cr(11), rw[2], ph, 'WT', { color: RED, bold: true, align: 'center' });
  [['G', 12], ['chain', 13], ['D', 14], ['cs', 15]].forEach(([t, n]) => {
    cell(rx[0], cr(n), rw[0], ph, t, { color: RED, bold: true });
    cell(rx[1], cr(n), rw[1], ph);
    cell(rx[2], cr(n), rw[2], ph);
  });

  // ---- 4. diamond / packet section --------------------------------------------------
  const dy = cr(16), dh = 3.5;
  cell(M, dy, W, dh, L.diamond, { color: RED, bold: true, align: 'center' });
  const g = W / 3;
  ['issue', 'return', 'broken'].forEach((t, i) => cell(M + g * i, dy + dh, g, dh, t, { align: 'center' }));
  for (let i = 0; i < 6; i++) {
    const lab = i % 2 === 0 ? 'Pcs' : 'weight';
    cell(M + (W / 6) * i, dy + dh * 2, W / 6, dh, lab, { align: 'center' });
  }
  for (let r = 0; r < 4; r++)
    for (let i = 0; i < 6; i++) cell(M + (W / 6) * i, dy + dh * (3 + r), W / 6, dh);

  embedEditData(doc, d, imgs);
  return doc;
}

module.exports = { buildJobCard };
