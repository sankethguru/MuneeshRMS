// billPdf.js
// Converts merged template HTML into a real PDF via a headless Chromium,
// since HTML/CSS is the actual template format (per the agreed design) —
// puppeteer-core (no bundled browser download) pointed at whatever real
// Chromium is available, so a single approach works both in this
// dev/sandbox environment and the Alpine container (see Dockerfile,
// where `apk add chromium` provides it at a known path).

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATE_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const p of CHROME_CANDIDATE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function htmlToPdfBuffer(html, options) {
  const landscape = !!(options && options.landscape);
  const executablePath = findChromePath();
  if (!executablePath) {
    throw new Error('No Chromium executable found on this server — PDF generation is unavailable. Set PUPPETEER_EXECUTABLE_PATH, or install Chromium (see Dockerfile).');
  }
  const browser = await puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({
      format: 'A4',
      landscape,
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    // page.pdf() in this puppeteer-core version returns a raw Uint8Array,
    // not a real Node.js Buffer — express's res.send() specifically
    // checks Buffer.isBuffer() to decide whether to stream raw binary or
    // fall back to JSON-serializing an unrecognized object, so a bare
    // Uint8Array silently turns into a broken {"0":37,"1":80,...}
    // response instead of a PDF. Fixed at the source, not per-caller, so
    // this function's own name ("...Buffer") is actually true for
    // everyone who calls it, not just the one route where this was
    // first noticed.
    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

const PDF_DIR = path.join(__dirname, 'data', 'generated-pdfs');

function pdfPathFor(entityKey, recordId) {
  return path.join(PDF_DIR, entityKey, `${recordId}.pdf`);
}

function pdfExists(entityKey, recordId) {
  return fs.existsSync(pdfPathFor(entityKey, recordId));
}

async function generateAndStore(entityKey, recordId, html, options) {
  const buffer = await htmlToPdfBuffer(html, options);
  const dir = path.join(PDF_DIR, entityKey);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pdfPathFor(entityKey, recordId), buffer);
}

module.exports = { htmlToPdfBuffer, findChromePath, pdfPathFor, pdfExists, generateAndStore, PDF_DIR };
