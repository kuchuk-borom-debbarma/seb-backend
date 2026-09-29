import { expect, test } from '@playwright/test'

test('the hero switches between the logo animation and the original building photo', async ({
  page,
}) => {
  await page.goto('/')

  const hero = page.locator('section#top:visible')
  await expect(hero).toHaveCount(1)
  const video = hero.getByTestId('mission-sep-hero-video')
  const building = hero.getByTestId('hero-building-image')
  await expect(video).toHaveAttribute('data-active', 'true')
  await hero.getByRole('button', { name: 'Council building' }).click()
  await expect(building).toHaveAttribute('data-active', 'true')
  await expect(building).toHaveAttribute('src', /hero-landscape/u)
  await expect(building.locator('..')).toHaveCSS('opacity', '1')
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(true)

  await hero.getByRole('button', { name: 'Mission SEP animation' }).click()
  await expect(video).toHaveAttribute('data-active', 'true')
  await expect(building).toHaveAttribute('data-active', 'false')
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).paused))
    .toBe(false)

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileHero = page.locator('section#top:visible')
  await expect(mobileHero).toHaveCount(1)
  await mobileHero.getByRole('button', { name: 'Council building' }).click()
  await expect(mobileHero.getByTestId('hero-building-image')).toHaveAttribute(
    'data-active',
    'true',
  )
  await expect(mobileHero.getByTestId('hero-building-image').locator('..')).toHaveCSS(
    'opacity',
    '1',
  )

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mobileHero.getByRole('button', { name: 'Mission SEP animation' }).click()
  await expect(mobileHero.getByRole('img', { name: 'Mission SEP logo' })).toBeVisible()
  await expect
    .poll(() =>
      mobileHero
        .getByTestId('mission-sep-hero-video')
        .evaluate((element) => (element as HTMLVideoElement).paused),
    )
    .toBe(true)
})
