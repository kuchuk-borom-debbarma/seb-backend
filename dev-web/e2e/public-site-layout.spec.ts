import { expect, test } from '@playwright/test'

test('the public hero uses the animation as a background and has no About gallery', async ({
  page,
}) => {
  await page.goto('/')

  const hero = page.locator('section#top:visible')
  const video = hero.getByTestId('mission-sep-hero-video')
  await expect(video).toBeVisible()
  const heroBounds = await hero.boundingBox()
  const videoBounds = await video.boundingBox()
  expect(videoBounds?.width).toBe(heroBounds?.width)
  expect(videoBounds?.height).toBe(heroBounds?.height)
  expect(await video.evaluate((element) => getComputedStyle(element).objectFit)).toBe(
    'contain',
  )
  await expect(video).toHaveAttribute('autoplay', '')
  await expect(video).toHaveAttribute('muted', '')
  await expect(video).toHaveAttribute('loop', '')
  await expect(video).toHaveAttribute('playsinline', '')
  await expect(video).toHaveAttribute('poster', /mission-sep-hero-poster/u)
  await expect(page.locator('#about')).toHaveCount(0)
  await expect(page.locator('a[href="/#about"]')).toHaveCount(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.locator('section#top:visible').getByTestId('mission-sep-hero-video'),
  ).toBeVisible()
  const mobileBounds = await page.locator('section#top:visible').boundingBox()
  const mobileVideoBounds = await page
    .locator('section#top:visible')
    .getByTestId('mission-sep-hero-video')
    .boundingBox()
  expect(mobileVideoBounds?.width).toBe(mobileBounds?.width)
  expect(mobileVideoBounds?.height).toBe(mobileBounds?.height)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const mobileHero = page.locator('section#top:visible')
  await expect(mobileHero.getByRole('img', { name: 'Mission SEP logo' })).toBeVisible()
  await expect(mobileHero.getByTestId('mission-sep-hero-video')).toBeHidden()
  await expect
    .poll(() =>
      mobileHero
        .getByTestId('mission-sep-hero-video')
        .evaluate((element) => (element as HTMLVideoElement).paused),
    )
    .toBe(true)
})

test('sign-in keeps its brand while the form has no illustration', async ({ page }) => {
  await page.goto('/login')

  await expect(page.locator('main img')).toHaveCount(0)
  await expect(page.locator('header img[alt="TTAADC Mission SEP"]').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
})
