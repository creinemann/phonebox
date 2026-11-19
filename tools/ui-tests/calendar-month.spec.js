const { test, expect } = require('@playwright/test');

// Calendar widget: dots on days with events, tap a day for its events, ‹ › to other months (read from the agent).
test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-19T12:00:00-06:00');
// local midnight in Chicago, written out: the test runner itself may run in another time zone
const local = (iso) => Date.parse(iso);
const NOV19 = local('2026-11-19T00:00:00-06:00'), NOV18 = local('2026-11-18T00:00:00-06:00');

const ev = (title, start, end, calendar, color, location = null, allDay = false) => ({ title, start, end, allDay, location, calendar, color });
// the panel's two weeks: Thursday evening the 19th in Chicago (00:30 UTC on the 20th)
const NEAR = [ev('Bird club talk', Date.parse('2026-11-20T00:30:00Z'), Date.parse('2026-11-20T01:30:00Z'), 'Home', '#34d399', 'Visitor Center')];
// March 2027: a timed evening event, an all-day one dated at UTC midnight, one on another calendar
const MARCH = [
  ev('Historical society talk', Date.parse('2027-03-12T00:00:00Z'), Date.parse('2027-03-12T01:30:00Z'), 'Talks', '#f59e0b', 'Juneau'),
  ev('Opening day', Date.UTC(2027, 2, 20), Date.UTC(2027, 2, 21), 'Boat', '#60a5fa', null, true),
  ev('Dentist', Date.parse('2027-03-03T15:00:00Z'), Date.parse('2027-03-03T16:00:00Z'), 'Home', '#34d399'),
];

// the layout, and the agent's answers in place of the demo's: /api/calendar (two weeks) and /api/calendar/range
function setup(page, options = {}, { range = true } = {}) {
  return page.addInitScript(({ opts, near, far, range, updated }) => {
    const config = JSON.stringify({
      night: { enabled: false }, rules: [], shortcuts: [],
      pages: [{ id: 'cal-test', title: 'Calendar', widgets: [{ id: 'cal', type: 'calendar', x: 0, y: 0, w: 8, h: 8, options: opts }] }],
    });
    localStorage.setItem('cfg', config);
    localStorage.setItem('pb-demo-config', config);
    window.__asked = [];
    const reply = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    let inner = window.fetch;
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      // the fallback is fixed when the wrapper is handed out (see i18n.spec.js)
      get: () => {
        const fallback = inner;
        return (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (url.pathname.endsWith('/api/calendar/range')) {
            const from = +url.searchParams.get('from'), to = +url.searchParams.get('to');
            window.__asked.push([from, to]);
            if (!range) return reply({}, 404);
            return reply({ events: [...near, ...far].filter((e) => e.end > from - 864e5 && e.start < to + 864e5) });
          }
          if (url.pathname.endsWith('/api/calendar')) return reply({ updated, errors: [], events: near });
          return fallback(input, init);
        };
      },
      set: (v) => { inner = v; },
    });
  }, { opts: options, near: NEAR, far: MARCH, range, updated: NOW.getTime() });
}
const asked = (page) => page.evaluate(() => window.__asked);

const widget = (page) => page.locator('[data-id="cal-test"] .w-calendar');
const day = (page, ms) => widget(page).locator(`.cal-d[data-day="${ms}"]`);

test('dots mark days with events, and a tapped day shows its events', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await setup(page);
  await page.goto('/panel/');
  await expect(widget(page).locator('.cal-month')).toHaveText('November 2026');
  const thu = day(page, NOV19);
  await expect(thu.locator('.cal-dots i')).toHaveCount(1);
  await expect(day(page, NOV18).locator('.cal-dots i')).toHaveCount(0);
  await thu.click();
  const pop = widget(page).locator('.cal-pop');
  await expect(pop.locator('.cal-pop-h')).toContainText(/Thursday.*19|19.*Thursday/);
  await expect(pop.locator('.ag-row')).toHaveCount(1);
  await expect(pop).toContainText('Bird club talk');
  await expect(pop).toContainText('Visitor Center');
  await pop.locator('.cal-x').click();
  await expect(pop).toHaveCount(0);
});

test('the arrows go to a future month, read from the agent, and the month name comes back', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await setup(page);
  await page.goto('/panel/');
  const next = widget(page).locator('.cal-nav').nth(1);
  for (let i = 0; i < 4; i++) await next.click();
  await expect(widget(page).locator('.cal-month')).toHaveText('March 2027');
  // the weeks shown: 1 March 2027 is a Monday, so Monday 1 March to Monday 5 April
  const [mar1, apr5] = [local('2027-03-01T00:00:00-06:00'), local('2027-04-05T00:00:00-05:00')];
  await expect.poll(async () => (await asked(page)).some(([f, t]) => f === mar1 && t === apr5)).toBe(true);
  await expect(day(page, local('2027-03-11T00:00:00-06:00')).locator('.cal-dots i')).toHaveCount(1); // the evening talk, local time
  const mar20 = local('2027-03-20T00:00:00-05:00');
  await expect(day(page, mar20).locator('.cal-dots i')).toHaveCount(1); // all day, on its own date
  await expect(day(page, local('2027-03-21T00:00:00-05:00')).locator('.cal-dots i')).toHaveCount(0);
  await day(page, mar20).click();
  await expect(widget(page).locator('.cal-pop')).toContainText('Opening day');
  await expect(widget(page).locator('.cal-pop')).toContainText('all day');
  await widget(page).locator('.cal-month').click();
  await expect(widget(page).locator('.cal-month')).toHaveText('November 2026');
  await expect(widget(page).locator('.cal-pop')).toHaveCount(0);
});

test('only the calendars named show, and an older agent keeps the two weeks it sends', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await setup(page, { calendars: 'Talks' }, { range: false });
  await page.goto('/panel/');
  await expect(widget(page).locator('.cal-month')).toHaveText('November 2026');
  await expect(widget(page).locator('.cal-dots i')).toHaveCount(0); // the talk is on "Home"
  await day(page, NOV19).click();
  await expect(widget(page).locator('.cal-pop')).toContainText('No events');
});

test('without events the widget is the plain month', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await setup(page, { events: false });
  await page.goto('/panel/');
  await expect(widget(page).locator('.cal-d.today')).toHaveText('19');
  await expect(widget(page).locator('.cal-dots')).toHaveCount(0);
  expect(await asked(page)).toHaveLength(0);
});
