const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Request Queue ─────────────────────────────────────────────
// Prevents multiple Puppeteer instances running simultaneously
// which would crash Railway's 512MB RAM limit
let isProcessing = false;
const queue = [];

function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  const { domain, res } = queue.shift();
  runPuppeteer(domain)
    .then(result => res.json(result))
    .catch(err => res.status(500).json({ domain, ads: 'ERROR', error: err.message }))
    .finally(() => {
      isProcessing = false;
      processQueue();
    });
}

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Ads Transparency Checker API is running',
    queue: queue.length,
    processing: isProcessing
  });
});

// ── Main endpoint ─────────────────────────────────────────────
app.get('/check-ads', handleCheck);
app.post('/check-ads', handleCheck);

function handleCheck(req, res) {
  const domain = req.query.domain || (req.body && req.body.domain);
  if (!domain) return res.status(400).json({ error: 'domain parameter is required' });

  let cleanDomain = domain.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  res.setTimeout(120000);
  queue.push({ domain: cleanDomain, res });
  processQueue();
}

// ── Puppeteer core ────────────────────────────────────────────
async function runPuppeteer(cleanDomain) {
  const url = `https://adstransparency.google.com/?region=FR&query=${encodeURIComponent(cleanDomain)}&domain=${encodeURIComponent(cleanDomain)}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
        '--single-process',
        '--memory-pressure-off',
        '--js-flags=--max-old-space-size=256'
      ]
    });

    const page = await browser.newPage();

    // Block images/fonts/media to save RAM and speed up
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(resolve => setTimeout(resolve, 6000));

    const hasAds = await page.evaluate(() => {
      function getAllText(el) {
        return el ? (el.innerText || el.textContent || '').toLowerCase() : '';
      }
      const buttons = document.querySelectorAll('button, a, [role="button"]');
      for (const btn of buttons) {
        const text = getAllText(btn);
        if (text.includes('see all ads') || text.includes('voir toutes les annonces') ||
            text.includes('voir toutes') || text.includes('see ads') || text.includes('all ads')) {
          return true;
        }
      }
      const adSelectors = ['creative-preview','ad-preview','[data-creative-id]','[data-ad-id]',
        '.ad-card','.creative-card','[class*="adCard"]','[class*="creativeCard"]',
        'google-ads-transparency-creative-preview'];
      for (const sel of adSelectors) {
        if (document.querySelector(sel)) return true;
      }
      const body = getAllText(document.body);
      const noAdsSignals = ['no ads','aucune annonce',"pas d'annonce","didn't find any",
        'no results found','aucun résultat','no ads to show','this advertiser has no ads'];
      for (const signal of noAdsSignals) {
        if (body.includes(signal)) return false;
      }
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.shadowRoot) {
          const shadowText = getAllText(el.shadowRoot);
          const shadowHTML = el.shadowRoot.innerHTML || '';
          if (shadowText.includes('see all ads') || shadowText.includes('voir toutes') ||
              shadowHTML.includes('creative-preview') || shadowHTML.includes('ad-card')) {
            return true;
          }
        }
      }
      const gridItems = document.querySelectorAll('[role="listitem"],[role="gridcell"],.result-item,[class*="result"]');
      if (gridItems.length > 2) return true;
      return false;
    });

    return { domain: cleanDomain, ads: hasAds ? 'YES' : 'NO', url };

  } finally {
    if (browser) await browser.close();
  }
}

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
