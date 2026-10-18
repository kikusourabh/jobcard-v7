const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { PDFDocument, PDFName, PDFDict, PDFArray, decodePDFRawStream } = require('pdf-lib');
const { buildJobCard } = require('./pdf');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Category -> P no prefix.  Edit this list to rename / add categories.
// ---------------------------------------------------------------------------
const CATEGORIES = {
  Set: 'SET', Ring: 'RN', Penden: 'PN', Earing: 'ER',
  Bangal: 'BN', Bracelet: 'BR', Nosepin: 'NP', Necklace: 'NK',
};

// P no = prefix + 3 random digits, e.g. NK472
//   GenName = name + "" + Math.random().toString().substring(2, 5)
// Used numbers are remembered in data/pnos.json so the same P no is never issued twice.
const DATA_DIR = path.join(__dirname, 'data');
const USED_FILE = path.join(DATA_DIR, 'pnos.json');
const readUsed = () => {
  try { return new Set(JSON.parse(fs.readFileSync(USED_FILE, 'utf8'))); } catch { return new Set(); }
};
const saveUsed = (set) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USED_FILE, JSON.stringify([...set]));
};

function genName(prefix, used) {
  for (let digits = 3; ; digits++) {            // falls back to 4, 5... digits if all 3-digit ones are taken
    for (let i = 0; i < 300; i++) {
      const num = Math.random().toString().substring(2, 2 + digits);
      if (num.length !== digits || !/^\d+$/.test(num)) continue;
      if (!used.has(prefix + num)) return prefix + num;
    }
  }
}

app.get('/api/categories', (req, res) => res.json(Object.keys(CATEGORIES)));

app.get('/api/gen-pno', (req, res) => {
  const prefix = CATEGORIES[req.query.category];
  if (!prefix) return res.status(400).json({ error: 'Unknown category' });
  res.json({ pno: genName(prefix, readUsed()) });
});

// Blank P no -> generate from the category. A typed P no is kept and remembered.
function resolvePno(input, category) {
  const used = readUsed();
  let pno = (input || '').trim();
  if (!pno) {
    const prefix = CATEGORIES[category];
    if (!prefix) throw new Error('Select a category (or type a P no)');
    pno = genName(prefix, used);
  }
  used.add(pno);
  saveUsed(used);
  return pno;
}

// File name for the download: the typed name (without .pdf / illegal characters),
// or the P no when left blank.
function safeFileName(input, fallback) {
  let n = String(input || '').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().slice(0, 100);
  if (!n) n = String(fallback).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_');
  return n + '.pdf';
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
const WHITE = { r: 255, g: 255, b: 255 };
const upright = (buf) => sharp(buf).rotate().toBuffer(); // apply EXIF rotation

async function cropFraction(buf, c) {
  const { width, height } = await sharp(buf).metadata();
  const left = Math.max(0, Math.round(c.x * width));
  const top = Math.max(0, Math.round(c.y * height));
  const w = Math.min(width - left, Math.round(c.w * width));
  const h = Math.min(height - top, Math.round(c.h * height));
  if (w < 5 || h < 5) return null;
  return sharp(buf).extract({ left, top, width: w, height: h }).toBuffer();
}

// diamond table on top, cropped design detail underneath, on one white canvas
async function stack(topBuf, cropBuf) {
  const W = 1200, GAP = 24;
  const top = await sharp(topBuf).resize({ width: W }).flatten({ background: WHITE }).jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true });
  const crop = await sharp(cropBuf).resize({ width: W, height: 480, fit: 'inside' }).flatten({ background: WHITE })
    .jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: W, height: top.info.height + GAP + crop.info.height, channels: 3, background: WHITE } })
    .composite([
      { input: top.data, top: 0, left: 0 },
      { input: crop.data, top: top.info.height + GAP, left: Math.round((W - crop.info.width) / 2) },
    ])
    .jpeg({ quality: 92 }).toBuffer();
}

const toJpeg = (buf) =>
  buf && sharp(buf).resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: WHITE }).jpeg({ quality: 90 }).toBuffer();

// ---------------------------------------------------------------------------
app.post(
  '/api/pdf',
  upload.fields([{ name: 'designImage', maxCount: 1 }, { name: 'diamondImage', maxCount: 1 }]),
  async (req, res) => {
    try {
      const b = req.body;
      const dFile = req.files?.designImage?.[0];
      const gFile = req.files?.diamondImage?.[0];

      let design = dFile ? await upright(dFile.buffer) : null;
      let diamond = gFile ? await upright(gFile.buffer) : null;

      // optional crops (fractions 0..1 of each image)
      const frac = (pre) => {
        const c = { x: +b[pre + 'X'], y: +b[pre + 'Y'], w: +b[pre + 'W'], h: +b[pre + 'H'] };
        return [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.w > 0 && c.h > 0 ? c : null;
      };
      const dc = design && frac('crop');      // design image crop
      const gc = diamond && frac('dcrop');    // diamond details image crop
      const designCrop = dc ? await cropFraction(design, dc) : null;
      if (gc) diamond = (await cropFraction(diamond, gc)) || diamond;

      if (designCrop) {
        const mode = b.cropMode || 'design';  // design | diamond | both
        if (mode === 'diamond' || mode === 'both') diamond = diamond ? await stack(diamond, designCrop) : designCrop;
        if (mode === 'design' || mode === 'both') design = designCrop;
      }

      const pno = resolvePno(b.pno, b.category);
      const doc = buildJobCard({ ...b, pno }, { designImage: await toJpeg(design), diamondImage: await toJpeg(diamond) });

      res.setHeader('Content-Type', 'application/pdf');
      const fileName = safeFileName(b.fileName, pno);
      res.setHeader('X-Pno', pno);
      res.setHeader('X-Filename', encodeURIComponent(fileName));
      res.setHeader('Access-Control-Expose-Headers', 'X-Pno, X-Filename');
      res.setHeader('Content-Disposition',
        `inline; filename="${fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      doc.pipe(res);
      doc.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Could not generate PDF: ' + err.message });
    }
  }
);

// ---------------------------------------------------------------------------
// Merge several PDFs into one (pages keep their original size, in upload order)
// ---------------------------------------------------------------------------
app.post('/api/merge', upload.array('pdfs', 100), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < 2) return res.status(400).json({ error: 'Choose at least 2 PDFs to merge' });
    const out = await PDFDocument.create();
    for (const f of files) {
      let src;
      try { src = await PDFDocument.load(f.buffer); }
      catch { return res.status(400).json({ error: `"${f.originalname}" could not be read as a PDF` }); }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => out.addPage(pg));
    }
    const bytes = await out.save();
    const fileName = safeFileName(req.body.fileName, 'merged');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Filename', encodeURIComponent(fileName));
    res.setHeader('X-Pages', String(out.getPageCount()));
    res.setHeader('Access-Control-Expose-Headers', 'X-Filename, X-Pages');
    res.setHeader('Content-Disposition',
      `inline; filename="${fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not merge PDFs: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Open a previously generated PDF for editing: read back the embedded data
// ---------------------------------------------------------------------------
async function readEmbeddedFiles(buf) {
  const pdf = await PDFDocument.load(buf, { updateMetadata: false });
  const names = pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names && names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const out = {};
  const walk = (node) => {
    if (!node) return;
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        const key = arr.lookup(i).decodeText();
        const spec = arr.lookup(i + 1, PDFDict);
        const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
        out[key] = Buffer.from(decodePDFRawStream(stream).decode());
      }
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  };
  walk(tree);
  return out;
}

const asDataUrl = (buf) => buf && 'data:image/jpeg;base64,' + buf.toString('base64');

app.post('/api/import-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF file first' });
    let files;
    try { files = await readEmbeddedFiles(req.file.buffer); }
    catch { return res.status(400).json({ error: 'Could not read this file as a PDF' }); }
    if (!files['jobcard-data.json']) {
      return res.status(400).json({
        error: 'This PDF has no editable data. Only PDFs generated by this app (after this update) can be edited.',
      });
    }
    const payload = JSON.parse(files['jobcard-data.json'].toString('utf8'));
    res.json({
      fields: payload.fields || {},
      designImage: asDataUrl(files['design.jpg']),
      diamondImage: asDataUrl(files['diamond.jpg']),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not open PDF: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Job card app running on http://localhost:${PORT}`));
