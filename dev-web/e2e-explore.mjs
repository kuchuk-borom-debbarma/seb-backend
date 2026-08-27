/* Drives the deployed Programme cycles area end to end, screenshotting every
   state and logging console errors + failed requests. Pure observation aid. */
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = 'https://seb-web.kuchukboromd-15a.workers.dev'
const OUT = process.env.OUT ?? './shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const problems = []
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`)
})
page.on('pageerror', (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`))
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url().slice(0, 140)}`)
})

let step = 0
const shot = async (name) => {
  step += 1
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png`, fullPage: true })
  console.log(`shot ${step} ${name}`)
}
const tryStep = async (name, fn) => {
  try { await fn() } catch (e) { problems.push(`step ${name}: ${String(e).split('\n')[0].slice(0, 220)}`) }
  await shot(name)
}

// ---- sign in
await page.goto(`${BASE}/login`)
await tryStep('login-filled', async () => {
  await page.getByLabel('Email address').fill('kuchukboromd@gmail.com')
  await page.getByLabel('Password', { exact: true }).fill('naijerLand1@94')
})
await tryStep('after-signin', async () => {
  await page.getByRole('button', { name: 'Sign In as Applicant' }).click()
  await page.waitForURL('**/admin**', { timeout: 20000 })
})

// ---- cycles list
await page.goto(`${BASE}/admin/cycles`)
await tryStep('cycles-list', async () => {})
await tryStep('cycles-list-filtered', async () => {
  const search = page.getByLabel(/code|search/iu).first()
  await search.fill('SEP', { timeout: 4000 })
})

// ---- create wizard, every step
await page.goto(`${BASE}/admin/cycles/new`)
await tryStep('wizard-step1-blank', async () => {})
const code = `TEST-${Date.now().toString(36).toUpperCase()}`
await tryStep('wizard-step1-filled', async () => {
  await page.getByLabel('Cycle code').fill(code)
  await page.getByLabel('Name', { exact: true }).fill('Exploration cycle')
  await page.getByLabel('Policy reference').fill('TTAADC/EXPLORE/1')
  await page.getByLabel('Guidance for applicants').fill('Exploration only.')
  const t = new Date(Date.now() - 3600e3).toISOString().slice(0, 16)
  await page.getByLabel('Applications open').fill(t)
})
await tryStep('wizard-step2', async () => {
  await page.getByRole('button', { name: /Next: Eligibility/u }).click()
})
await tryStep('wizard-step3', async () => {
  await page.getByRole('button', { name: /Next: Expansion/u }).click()
})
await tryStep('wizard-step4', async () => {
  await page.getByRole('button', { name: /Next: Desk review/u }).click()
})
await tryStep('created-cycle-page', async () => {
  await page.getByRole('button', { name: 'Create draft cycle' }).click()
  await page.waitForURL(/\/admin\/cycles\/[0-9a-f-]{36}$/u, { timeout: 20000 })
})
const cycleUrl = page.url()

// ---- cycle page states
await tryStep('edit-draft-rules-open', async () => {
  await page.getByText("Edit this draft’s rules").click()
})
await tryStep('draft-rules-saved-no-guidance', async () => {
  await page.getByLabel('Reason for this change').fill('exploration save')
  // clear guidance to prove a draft saves incomplete
  await page.getByLabel('Guidance for applicants').fill('')
  await page.getByRole('button', { name: "Save the draft’s rules" }).click()
  await page.waitForTimeout(2500)
})

// ---- form editor
await tryStep('form-editor', async () => {
  await page.getByRole('link', { name: 'Edit the form' }).click()
  await page.waitForURL(/\/form$/u, { timeout: 15000 })
})
await tryStep('form-editor-add-stage', async () => {
  await page.getByLabel('Reason for these changes').fill('exploration')
  await page.getByRole('button', { name: 'Add a stage' }).click()
})
await tryStep('form-editor-stage-saved', async () => {
  await page.getByLabel('Stage key').fill('EXPLORE')
  await page.getByLabel('Heading').fill('Exploration stage')
  await page.getByRole('button', { name: 'Save stage' }).click()
  await page.waitForTimeout(2000)
})
await tryStep('form-editor-structures', async () => {
  await page.getByRole('button', { name: 'Structures' }).click()
})

// ---- preview
await tryStep('preview', async () => {
  await page.goto(`${cycleUrl}/preview`)
  await page.waitForTimeout(1500)
})
await tryStep('preview-stage2', async () => {
  await page.getByRole('button', { name: 'Project cost and funding' }).click()
})
await tryStep('preview-owners-add', async () => {
  await page.getByRole('button', { name: 'Owners', exact: true }).first().click()
  await page.getByRole('button', { name: 'Add owners' }).click()
})

// ---- lifecycle: open, change closing, remove closing, close, archive
await page.goto(cycleUrl)
await tryStep('open-modal', async () => {
  await page.getByRole('button', { name: 'Open for applications' }).click()
})
await tryStep('opened', async () => {
  await page.getByLabel('Reason for this action').fill('exploration open')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(2500)
})
await tryStep('change-closing-modal', async () => {
  await page.getByRole('button', { name: 'Change closing time' }).click()
})
await tryStep('closing-removed', async () => {
  await page.getByLabel(/Reason/u).last().fill('no deadline')
  await page.getByRole('button', { name: 'Remove the closing time' }).click()
  await page.waitForTimeout(2500)
})
await tryStep('closed', async () => {
  await page.getByRole('button', { name: 'Close to new applications' }).click()
  await page.getByLabel('Reason for this action').fill('exploration close')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(2500)
})
await tryStep('archived', async () => {
  await page.getByRole('button', { name: 'Archive cycle' }).click()
  await page.getByLabel('Reason for this action').fill('exploration done')
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.waitForTimeout(2500)
})

console.log('\n--- PROBLEMS (' + problems.length + ') ---')
for (const p of [...new Set(problems)]) console.log(p)
await browser.close()
