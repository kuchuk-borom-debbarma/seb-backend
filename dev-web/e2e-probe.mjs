import { chromium } from '@playwright/test'
const BASE = 'https://seb-web.kuchukboromd-15a.workers.dev'
const OUT = process.env.OUT
const CYCLE = '83277f9b-96e4-402d-9a95-12aaf61f8507'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)) })
await page.goto(`${BASE}/login`)
await page.getByLabel('Email address').fill('kuchukboromd@gmail.com')
await page.getByLabel('Password', { exact: true }).fill('naijerLand1@94')
await page.getByRole('button', { name: 'Sign In as Applicant' }).click()
await page.waitForURL('**/admin**', { timeout: 20000 })
page.on('pageerror', (e) => console.log('pageerror:', String(e).slice(0, 160)))
await page.goto(`${BASE}/admin/cycles/${CYCLE}`)
// Click until the dialog exists: a click that lands before hydration is void.
let opened = false
for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
  await page.getByRole('button', { name: 'Open for applications' }).click()
  opened = await page
    .getByRole('dialog')
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true, () => false)
  console.log(`attempt ${attempt + 1}: dialog=${opened}`)
}
await page.getByLabel('Reason for this action').fill('probe open with blank guidance')
await page.getByRole('button', { name: 'Confirm' }).click()
for (const wait of [1500, 3000, 5000]) {
  await page.waitForTimeout(wait)
  const modal = await page.getByRole('dialog').count()
  const alert = await page.getByRole('alert').allInnerTexts().catch(() => [])
  console.log(`t+${wait}: modal=${modal} alerts=${JSON.stringify(alert)}`)
  await page.screenshot({ path: `${OUT}/probe-${wait}.png` })
}
await browser.close()
