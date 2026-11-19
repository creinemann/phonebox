const { test, expect } = require('@playwright/test');

// Web page widget: a frame with the page itself in a browser, and in the app (through the agent) a page on the
// computer or the local network under an origin of its own per widget, never the panel's.
function withPage(page, widgets) {
  return page.addInitScript((list) => {
    const config = JSON.stringify({
      night: { enabled: false }, rules: [], shortcuts: [],
      pages: [{ id: 'web-test', title: 'Web', widgets: list }],
    });
    localStorage.setItem('cfg', config);
    localStorage.setItem('pb-demo-config', config);
  }, widgets);
}

test('the page shows in a sandboxed frame, still by default, with zoom', async ({ page }) => {
  await page.route('https://weather.example/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>41°F</h1>' }));
  await withPage(page, [
    { id: 'wx', type: 'webpage', x: 0, y: 0, w: 6, h: 6, options: { url: 'https://weather.example/Current-Weather', zoom: 50 } },
    { id: 'tap', type: 'webpage', x: 6, y: 0, w: 6, h: 6, options: { url: 'https://weather.example/', interactive: true } },
  ]);
  await page.goto('/panel/');
  const frame = page.locator('[data-id="web-test"] .w-webpage iframe').first();
  await expect(frame).toHaveAttribute('src', 'https://weather.example/Current-Weather');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  await expect(frame).toHaveClass(/web-still/);
  expect(await frame.evaluate((f) => f.style.transform)).toBe('scale(0.5)');
  await expect(page.frameLocator('[data-id="web-test"] .w-webpage iframe >> nth=0').locator('h1')).toHaveText('41°F');
  await expect(page.locator('[data-id="web-test"] .w-webpage iframe').nth(1)).not.toHaveClass(/web-still/);
});

test('a widget without an http address says what to set', async ({ page }) => {
  await withPage(page, [{ id: 'bad', type: 'webpage', x: 0, y: 0, w: 6, h: 6, options: { url: 'javascript:alert(1)' } }]);
  await page.goto('/panel/');
  await expect(page.locator('[data-id="web-test"] .w-webpage iframe')).toHaveCount(0);
  await expect(page.locator('[data-id="web-test"] .w-webpage .empty')).toBeVisible();
});

test('in the app, local and http pages go through the computer under their own origin', async ({ page }) => {
  await page.goto('/panel/');
  const got = await page.evaluate(async () => {
    const { webPageSrc, localHost } = await import('./widgets/web.js');
    return {
      pc: webPageSrc('http://127.0.0.1:8014/Current-Weather?u=f', 'home/card-1', 'auto', true),
      lan: webPageSrc('https://192.168.1.36/', 'home/card-1', 'auto', true),
      internet: webPageSrc('https://example.com/x', 'home/card-1', 'auto', true),
      forced: webPageSrc('https://example.com/x', 'home/card-1', 'pc', true),
      direct: webPageSrc('http://127.0.0.1:8014/', 'home/card-1', 'direct', true),
      browser: webPageSrc('http://127.0.0.1:8014/', 'home/card-1', 'auto', false),
      other: webPageSrc('http://127.0.0.1:8014/', 'home/card-2', 'auto', true),
      long: webPageSrc('http://127.0.0.1:8014/', 'page/stack-with-a-long-id:card-mi2k3abc-ab12cd', 'auto', true),
      hosts: ['127.0.0.1', '10.1.2.3', '172.20.0.1', 'weatherpc', 'nas.local', '[::1]', 'example.com', '8.8.8.8', '172.32.0.1']
        .map((h) => localHost(h)),
    };
  });
  expect(got.pc).toBe('https://686f6d652f636172642d31.pcweb.androidplatform.net/Current-Weather?u=f');
  expect(got.lan).toBe('https://686f6d652f636172642d31.pcweb.androidplatform.net/');
  expect(got.internet).toBe('https://example.com/x');
  expect(got.forced).toBe('https://686f6d652f636172642d31.pcweb.androidplatform.net/x');
  expect(got.direct).toBe('http://127.0.0.1:8014/');
  expect(got.browser).toBe('http://127.0.0.1:8014/');
  expect(new URL(got.other).host).not.toBe(new URL(got.pc).host); // one origin per widget
  // a DNS label holds at most 63 characters
  expect(new URL(got.long).hostname.split('.').every((label) => label.length <= 63)).toBe(true);
  expect(got.hosts).toEqual([true, true, true, true, true, true, false, false, false]);
});
