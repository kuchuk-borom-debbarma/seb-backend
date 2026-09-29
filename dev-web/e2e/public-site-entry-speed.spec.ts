import { expect, test } from '@playwright/test'

test('desktop sector cards enter early in the pinned section', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const section = page.locator('#project')
  await expect(section).toBeVisible()
  await expect
    .poll(() =>
      section
        .locator('[data-entry="right-outer"]')
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBe(0)
  await section.evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 100)
  })

  // Allow the scroll-linked scrub to settle before checking the outermost card.
  await page.waitForTimeout(700)
  const opacity = await section
    .locator('[data-entry="right-outer"]')
    .evaluate((element) => Number(getComputedStyle(element).opacity))
  expect(opacity).toBeGreaterThan(0.8)
})

test('the Apply Online step appears near the start of its pinned section', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const stage = page.locator('#how-it-works > div').first()
  await expect(stage).toBeVisible()
  await expect
    .poll(() =>
      stage
        .locator('.proc-text-block')
        .first()
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBe(0)
  await stage.evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 100)
  })

  await page.waitForTimeout(700)
  const opacity = await stage
    .locator('.proc-text-block')
    .first()
    .evaluate((element) => Number(getComputedStyle(element).opacity))
  expect(opacity).toBeGreaterThan(0.8)
})
