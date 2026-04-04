const { test } = require('@playwright/test');

test('landing smoke', async ({ page, browser }) => {
  const results = [];
  const consoleErrors = [];
  const pageErrors = [];
  const record = (name, ok, detail = '') => results.push({ name, ok, detail });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const url = 'https://biol-visitor-nissan-fresh.trycloudflare.com';
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  const title = await page.title();
  record('title', /Kyros Studio/i.test(title), title);

  const heroText = await page.locator('h1').first().textContent();
  record('hero heading present', Boolean(heroText), heroText || '');

  const featuresLink = page.getByRole('link', { name: /Features/i }).first();
  if (await featuresLink.count()) {
    await featuresLink.click();
    await page.waitForTimeout(500);
    record('features nav click', page.url().includes('#features'), page.url());
  } else {
    record('features nav click', false, 'missing');
  }

  const faqLink = page.getByRole('link', { name: /FAQ/i }).first();
  if (await faqLink.count()) {
    await faqLink.click();
    await page.waitForTimeout(500);
    record('faq nav click', page.url().includes('#faq'), page.url());
  } else {
    record('faq nav click', false, 'missing');
  }

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const cta = page.getByRole('button', { name: /Create Account|Get Started|Get Access/i }).first();
  if (await cta.count()) {
    await cta.click();
    await page.waitForTimeout(700);
    const body = (await page.locator('body').textContent()) || '';
    record('cta navigates to auth', /create your account|sign up|register|already have an account/i.test(body), body.slice(0, 180));
  } else {
    record('cta navigates to auth', false, 'missing CTA');
  }

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.65));
  await page.waitForTimeout(700);
  const faqQuestion = page.locator('button').filter({ hasText: 'What is Kyros Studio actually for?' }).first();
  if (await faqQuestion.count()) {
    await faqQuestion.click();
    await page.waitForTimeout(400);
    const expanded = await page.locator('text=hosted AI creative platform').count();
    record('faq expands', expanded > 0, String(expanded));
  } else {
    record('faq expands', false, 'missing faq');
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(400);
  const footerText = await page.locator('footer').textContent().catch(() => '');
  record('footer visible', Boolean(footerText), (footerText || '').trim().slice(0, 120));

  const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileErrors = [];
  mobilePage.on('pageerror', (err) => mobileErrors.push(String(err)));
  await mobilePage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const menuBtn = mobilePage.getByRole('button', { name: /Toggle menu/i }).first();
  if (await menuBtn.count()) {
    await menuBtn.click();
    await mobilePage.waitForTimeout(500);
    const visible = await mobilePage.locator('#mobile-menu').isVisible().catch(() => false);
    record('mobile menu opens', visible, visible ? 'visible' : 'hidden');
  } else {
    record('mobile menu opens', false, 'missing menu button');
  }
  await mobilePage.close();

  console.log('SMOKE_RESULTS_START');
  console.log(JSON.stringify({ results, consoleErrors, pageErrors: pageErrors.concat(mobileErrors) }, null, 2));
  console.log('SMOKE_RESULTS_END');
});
