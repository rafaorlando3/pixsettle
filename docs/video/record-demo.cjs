// Grava o vídeo da demo (legendas em inglês na tela) contra a instância local com Tempo testnet real.
// Uso: PW=$(npm root -g)/playwright node docs/video/record-demo.cjs <pasta>; depois ffmpeg -f concat -safe 0 -i <pasta>/concat.txt ... (ver docs/video/README.md)
const { chromium } = require(process.env.PW)
const OUT = process.argv[2]
const BASE = process.env.BASE ?? 'http://127.0.0.1:8080'
const W = 1440, H = 810
const sleep = ms => new Promise(r => setTimeout(r, ms))

const slide = (title, lines = [], foot = '') => `<!doctype html><html><body style="margin:0;height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#0f766e,#0e7490);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#fff">
<div style="max-width:1100px;padding:40px">
<div style="font-size:64px;font-weight:800;letter-spacing:-.02em;line-height:1.1">${title}</div>
${lines.map(l => `<div style="font-size:34px;margin-top:22px;opacity:.95;line-height:1.3">${l}</div>`).join('')}
${foot ? `<div style="font-size:22px;margin-top:44px;opacity:.75">${foot}</div>` : ''}
</div></body></html>`

async function caption(page, text) {
  await page.evaluate(t => {
    let el = document.getElementById('__cap')
    if (!el) {
      el = document.createElement('div'); el.id = '__cap'
      Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '26px', transform: 'translateX(-50%)', background: 'rgba(15,23,42,.92)', color: '#fff',
        padding: '14px 24px', borderRadius: '14px', font: '600 26px system-ui,-apple-system,Segoe UI,Roboto,sans-serif', zIndex: 2147483647, maxWidth: '86%', textAlign: 'center',
        boxShadow: '0 10px 30px rgba(0,0,0,.25)', transition: 'opacity .25s' })
      document.body.append(el)
    }
    el.style.opacity = t ? '1' : '0'; el.textContent = t
  }, text)
}

;(async () => {
  const browser = await chromium.launch({ args: ['--proxy-server=https=' + process.env.HTTPS_PROXY.replace('http://', ''), '--proxy-bypass-list=<-loopback>'] })
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, bypassCSP: true, colorScheme: 'light' })
  const page = await ctx.newPage()
  // Captura por screenshots com horário real: tempo do vídeo fiel ao relógio, sem quadro perdido.
  const fs = require('fs'); fs.mkdirSync(OUT + '/shots', { recursive: true })
  const shots = []; let recording = true
  const loop = (async () => {
    let i = 0
    while (recording) {
      const t = Date.now(); const file = `${OUT}/shots/${String(i).padStart(6, '0')}.jpg`
      try { await page.screenshot({ path: file, type: 'jpeg', quality: 92, animations: 'allow', caret: 'initial' }); shots.push([file, t]); i++ } catch { }
      const wait = 100 - (Date.now() - t); if (wait > 0) await sleep(wait)
    }
  })()
  const marks = []; const t0 = Date.now(); const mark = n => marks.push([n, ((Date.now() - t0) / 1000).toFixed(1)])

  // Abertura
  await page.setContent(slide('PixSettle', ['Pix in, stablecoin out,<br>with a receipt anyone can verify.'], 'Crypto World\'s Fair, Tempo track'))
  mark('title'); await sleep(5000)
  await page.setContent(slide('Brazil pays with Pix.', ['About 148 million people use it (Central Bank of Brazil, end of 2025).', 'Across the border, 35,000+ Paraguayan shops already accept Pix from Brazilian shoppers. They want dollars.'], 'Sources: Central Bank of Brazil; ABC Color, Jul 15, 2026'))
  mark('market'); await sleep(8000)
  await page.setContent(slide('Three problems.', ['1. Settlement to dollars is a black box.', '2. Webhooks arrive more than once. Naive code pays twice.', '3. A Pix can be clawed back for up to 80 days (MED).']))
  mark('problem'); await sleep(8000)

  // Demo
  await page.goto(BASE + '/demo'); await page.waitForSelector('#create')
  await caption(page, 'This is the live demo. Pix is simulated; the stablecoin transfer is real, on Tempo testnet.'); mark('demo'); await sleep(4500)
  await page.fill('#amt', '100,90'); await page.fill('#desc', 'Sneakers, size 42')
  await caption(page, '1. The merchant creates an order through the PixSettle API.'); await sleep(2000)
  await page.click('#create'); await page.waitForSelector('#phone iframe'); await sleep(3500)
  await caption(page, '2. The payer gets a Pix QR code on their phone.'); await sleep(4000)
  await caption(page, '3. The payer pays. The provider sends the same webhook three times, on purpose.'); await sleep(2500)
  await page.click('#pay'); mark('pay')
  await caption(page, '4. PixSettle settles ONCE on Tempo: signed offline, sent, reconciled by hash.')
  await page.waitForSelector('#links button:has-text("Open verifiable receipt")', { timeout: 90000 }); mark('settled')
  await sleep(1500)
  const secs = await page.textContent('#k-time')
  await caption(page, `Settled ${secs} after the Pix. 3 webhooks, 1 transfer, every step recorded.`); await sleep(3000)
  await page.evaluate(() => document.querySelector('ol.timeline').scrollIntoView({ behavior: 'smooth', block: 'start' })); await sleep(5000)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(1500)

  // Devoluções e MED
  await caption(page, 'Refunds go through the API. A rolling reserve (simulated accounting) covers them first.')
  await page.click('#refund'); await page.waitForSelector('#refunds a:has-text("notice")', { timeout: 30000 }); await sleep(1500)
  await page.evaluate(() => document.getElementById('refund-card').scrollIntoView({ behavior: 'smooth', block: 'center' })); await sleep(3500)
  await caption(page, 'A MED fraud claim (simulated) uses what is left of the reserve; the rest becomes merchant debt.')
  await page.waitForSelector('#med:not([disabled])', { timeout: 30000 }); await page.click('#med')
  await page.waitForFunction(() => document.querySelectorAll('#refunds a').length === 2, null, { timeout: 30000 }); mark('med'); await sleep(5000)
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await sleep(1000)

  // Explorador e recibo
  const explorer = await page.getAttribute('#links a:has(button:has-text("View on Tempo explorer"))', 'href')
  const receipt = await page.getAttribute('#links a:has(button:has-text("Open verifiable receipt"))', 'href')
  await page.goto(explorer, { waitUntil: 'domcontentloaded' }).catch(() => {})
  await sleep(2500); await caption(page, 'The transfer on the Tempo explorer, tagged with the settlement memo.'); mark('explorer'); await sleep(6000)
  await page.goto(BASE + receipt); await caption(page, 'The receipt is verified in your browser, against the public Tempo RPC. No trust in our server.')
  await page.waitForSelector('#hero.ok, #hero.bad, #hero.warn', { timeout: 30000 }); mark('receipt'); await sleep(6000)
  await page.evaluate(() => window.scrollTo({ top: 520, behavior: 'smooth' })); await sleep(4000)

  // Retenção por valor errado
  await page.goto(BASE + '/demo'); await page.waitForSelector('#create')
  await page.fill('#amt', '59,90'); await page.fill('#desc', 'T-shirt')
  await page.click('#create'); await page.waitForSelector('#phone iframe'); await sleep(2000)
  await caption(page, 'Wrong amount? The order is held with a reason. Nothing goes on-chain.')
  await page.click('#under'); await page.waitForSelector('#status.bad', { timeout: 20000 }); mark('hold'); await sleep(5500)
  await caption(page, '')

  // Fechamento
  await page.setContent(slide('Never paid twice.', ['Durable send journal, same bytes on every retry, reconcile by hash, treasury pause.', 'Refunds blocked while a settlement is in flight.', '60 automated tests, including cases written by an independent reviewer.']))
  mark('trust'); await sleep(8000)
  await page.setContent(slide('Business', ['A take rate on settled volume, with a licensed FX partner doing the conversion.', 'PixSettle is software. No custody of customer funds.', 'Starting in Pedro Juan Caballero, Paraguay.'], 'Merchant interview results: Oct 3 to 8'))
  mark('business'); await sleep(8000)
  await page.setContent(slide('PixSettle', ['Built on Tempo. Open source (MIT).'], 'Demo: testnet and simulated Pix. No real money moves.'))
  mark('end'); await sleep(5000)

  recording = false; await loop
  const lines = []
  for (let k = 0; k < shots.length; k++) {
    const d = k + 1 < shots.length ? (shots[k + 1][1] - shots[k][1]) / 1000 : 0.5
    lines.push(`file '${shots[k][0]}'`, `duration ${d.toFixed(3)}`)
  }
  lines.push(`file '${shots[shots.length - 1][0]}'`)
  fs.writeFileSync(OUT + '/concat.txt', lines.join('\n') + '\n')
  await ctx.close(); await browser.close()
  console.log(JSON.stringify(marks), 'frames', shots.length)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
