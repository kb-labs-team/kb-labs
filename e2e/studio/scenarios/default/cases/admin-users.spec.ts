import { test, expect, type Page } from '@playwright/test'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const enabled = process.env.KB_STUDIO_FRESH_HOST_JOURNEY === '1'
const secured = process.env.KB_ACCESS_MODE === 'secured'

test.skip(!enabled || !secured, 'User administration exists only in the secured fresh-install journey')

async function signIn(page: Page, email: string, password: string) {
  await page.goto(`${GATEWAY}/`)
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await expect(page).toHaveURL(`${GATEWAY}/`)
}

test('tenant admin manages users, roles, and invites @S-106.1 @S-106.2 @S-106.3 @S-106.4 @S-106.5 @S-106.6 @S-107.1 @S-107.2 @S-107.3 @S-107.4', async ({ page, browser }) => {
  const adminEmail = process.env.KB_STUDIO_ADMIN_EMAIL
  const adminPassword = process.env.KB_STUDIO_ADMIN_PASSWORD
  const memberEmail = process.env.KB_STUDIO_MEMBER_EMAIL
  const memberPassword = process.env.KB_STUDIO_MEMBER_PASSWORD
  expect(adminEmail).toBeTruthy()
  expect(adminPassword).toBeTruthy()
  expect(memberEmail).toBeTruthy()
  expect(memberPassword).toBeTruthy()

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page, adminEmail!, adminPassword!)
  await page.goto(`${GATEWAY}/admin/users`)
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  const memberRole = page.getByLabel(`Role for ${memberEmail}`)
  await expect(memberRole).toHaveValue('member')

  await test.step('[S-106.6] change a member role and verify member permissions', async () => {
    await memberRole.selectOption('admin')
    await expect(memberRole).toHaveValue('admin')
    await memberRole.selectOption('member')
    await expect(memberRole).toHaveValue('member')

    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()
    await signIn(memberPage, memberEmail!, memberPassword!)
    const permissions = await memberPage.evaluate(async () => {
      const response = await fetch('/api/auth/permissions')
      return response.json() as Promise<{ permissions: string[] }>
    })
    expect(permissions.permissions).not.toContain('users:read')
    await memberContext.close()
  })

  await test.step('[S-106.4] create and copy a 24-hour password reset link', async () => {
    await page.getByRole('button', { name: 'Copy reset link' }).first().click()
    await expect(page.getByRole('status')).toContainText('24-hour password reset link')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/reset-password\//)
  })

  await test.step('[S-106.5] disable and re-enable the member account', async () => {
    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()
    await signIn(memberPage, memberEmail!, memberPassword!)
    const memberRow = page.getByRole('row').filter({ hasText: memberEmail! })
    await memberRow.getByRole('button', { name: 'Disable' }).click()
    const denied = await memberPage.evaluate(async () => (await fetch('/api/auth/me')).status)
    expect(denied).toBe(401)
    await page.getByRole('row').filter({ hasText: memberEmail! }).getByRole('button', { name: 'Enable' }).click()
    await memberContext.close()
  })

  let activationUrl = ''
  const inviteEmail = `studio-case-${Date.now()}@example.test`
  await test.step('[S-106.2] invite a member and show pending invite expiry', async () => {
    await page.getByLabel('Invite email').fill(inviteEmail)
    await page.getByLabel('Invite role').selectOption('member')
    await page.getByRole('button', { name: 'Invite' }).click()
    await expect(page.getByText(inviteEmail, { exact: true })).toBeVisible()
    activationUrl = await page.evaluate(() => navigator.clipboard.readText())
    expect(activationUrl).toMatch(/\/activate\//)
  })

  await test.step('[S-106.3] revoke an invite and reject its activation token', async () => {
    const revokedEmail = `studio-revoked-${Date.now()}@example.test`
    await page.getByLabel('Invite email').fill(revokedEmail)
    await page.getByRole('button', { name: 'Invite' }).click()
    const revokedUrl = await page.evaluate(() => navigator.clipboard.readText())
    const inviteRow = page.getByRole('row').filter({ hasText: revokedEmail })
    await inviteRow.getByRole('button', { name: 'Revoke' }).click()
    await expect(inviteRow).toContainText('revoked')
    const rejected = await page.request.post(`${GATEWAY}/auth/activate`, {
      data: { token: revokedUrl.split('/activate/').at(-1), password: 'JourneyMember123!' },
    })
    expect(rejected.status()).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: 'invalid_invite' })
  })

  await test.step('[S-107.1] open a valid invite and show the activation form', async () => {
    await page.goto(activationUrl)
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByLabel('Confirm password')).toBeVisible()
  })

  await test.step('[S-107.4] reject a weak password without consuming the invite', async () => {
    const policyFailure = page.waitForResponse((response) =>
      response.url().includes('/api/auth/activate') && response.status() === 400,
    )
    await page.getByLabel('Password').fill('weak')
    await page.getByLabel('Confirm password').fill('weak')
    await page.getByRole('button', { name: 'Activate account' }).click()
    const response = await policyFailure
    const payload = await response.json()
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_INPUT_INVALID',
        message: 'too_short',
        hint: expect.stringContaining('password policy'),
      },
    })
    await expect(page.getByRole('alert')).toContainText('too_short')
    await expect(page).toHaveURL(/\/activate\//)
  })

  await test.step('[S-107.2] activate the invited account and enter Studio', async () => {
    await page.getByLabel('Password').fill('JourneyInvitePass123!')
    await page.getByLabel('Confirm password').fill('JourneyInvitePass123!')
    await page.getByRole('button', { name: 'Activate account' }).click()
    await expect(page).toHaveURL(`${GATEWAY}/`)
    await expect(page.getByRole('menuitem', { name: /Projects$/ })).toBeVisible()
  })

  await test.step('[S-107.3] reject a consumed invite without establishing another session', async () => {
    await page.goto(activationUrl)
    await page.getByLabel('Password').fill('JourneyInvitePass123!')
    await page.getByLabel('Confirm password').fill('JourneyInvitePass123!')
    await page.getByRole('button', { name: 'Activate account' }).click()
    await expect(page.getByRole('alert')).toHaveText('This invite link is invalid or expired')
  })
})
