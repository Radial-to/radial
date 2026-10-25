// The color picker (src/renderer/colorPicker.ts) in a real Chromium page: it
// opens on, and reads back, colors in any CSS color space (Tailwind v4 sites
// use oklch() everywhere), and closing it in the middle of a drag is clean.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';

/** open()'s options (src/renderer/types.d.ts ColorPickerOptions), the ones these checks pass. */
interface PickerOptions { color?: string; onClose?: (css: string | null) => void }
/** What the page holds: colorPicker.js's API, and what the picker handed back on close. */
interface PageGlobals {
  RadialColorPicker: { open(options: PickerOptions): void; close(commit?: boolean): void; isOpen(): boolean };
  committed: (string | null)[];
}
declare const window: Window & typeof globalThis & PageGlobals;

/** A page with the app's styles and the compiled picker, and the errors it throws. */
async function pickerPage(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } }); page.setDefaultTimeout(6000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://radial.test/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://radial.test/');
  await page.addStyleTag({ content: fs.readFileSync('src/renderer/styles.css', 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync('out/renderer/colorPicker.js', 'utf8') });
  await page.evaluate(() => { window.committed = []; });
  return { page, errors };
}
/** Opens the picker on a color and reads the value field, in whichever format tab is on. */
async function openOn(page: Page, color: string): Promise<string> {
  await page.evaluate(color => window.RadialColorPicker.open({ color, onClose: css => window.committed.push(css) }), color);
  return page.locator('.rcp-input').inputValue();
}
/** A #rrggbb or #rrggbbaa value as numbers. */
function channels(hex: string): number[] {
  assert.match(hex, /^#[0-9a-f]{6}([0-9a-f]{2})?$/, `${hex} is a hex color`);
  return (hex.slice(1).match(/../g) || []).map(pair => parseInt(pair, 16));
}
/** Within one step per channel: Chromium versions may round a conversion differently. */
function near(actual: string, expected: number[], label: string): void {
  const got = channels(actual);
  assert.equal(got.length, expected.length, `${label}: ${actual} has ${expected.length === 4 ? 'an' : 'no'} alpha`);
  assert.ok(got.every((value, i) => Math.abs(value - expected[i]) <= 1), `${label}: expected about ${expected.join(', ')}, got ${got.join(', ')} (${actual})`);
}

test('the picker opens on colors in any CSS color space, not black', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await pickerPage(browser);
    // sRGB values from CSS Color 4's conversions (what Chromium paints them as).
    const cases: [string, number[]][] = [
      ['#40b1b7', [64, 177, 183]],
      ['rgb(10 20 30 / 50%)', [10, 20, 30, 128]],
      ['oklch(0.7 0.1 200)', [64, 177, 183]],
      ['oklch(0.7 0.1 200 / 0.5)', [64, 177, 183, 128]],
      ['oklch(0.637 0.237 25.331)', [251, 44, 54]],
      ['lab(50 20 30)', [161, 105, 69]],
      ['lch(50 30 40)', [162, 103, 87]],
      ['oklab(0.6 0.1 -0.1)', [159, 99, 186]],
      ['color(display-p3 1 0 0)', [255, 0, 0]],
      ['color(display-p3 0.2 0.4 0.6 / 0.25)', [26, 104, 157, 64]],
      ['color-mix(in srgb, red 50%, blue)', [128, 0, 128]],
    ];
    for (const [color, expected] of cases) {
      near(await openOn(page, color), expected, color);
      await page.evaluate(() => window.RadialColorPicker.close(false));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the picker reads back its own OKLCH value, typed or committed', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await pickerPage(browser);
    near(await openOn(page, '#40b1b7'), [64, 177, 183], 'opened on hex');
    await page.locator('[data-tab=oklch]').click();
    const input = page.locator('.rcp-input');
    assert.match(await input.inputValue(), /^oklch\(0\.7 0\.1 /);
    // Enter reads the field: here, the picker's own OKLCH value.
    await input.focus(); await input.press('Enter');
    await page.locator('[data-tab=hex]').click();
    near(await input.inputValue(), [64, 177, 183], 'Enter in the OKLCH tab');
    // Committed in OKLCH (the format choice is remembered), then reopened on that value.
    await page.locator('[data-tab=oklch]').click();
    await page.evaluate(() => window.RadialColorPicker.close(true));
    const committed = await page.evaluate(() => window.committed.at(-1));
    assert.match(committed || '', /^oklch\(0\.7 0\.1 /);
    assert.match(await openOn(page, committed!), /^oklch\(0\.7 0\.1 /, 'reopened in the OKLCH tab, on the same color');
    await page.locator('[data-tab=hex]').click();
    near(await input.inputValue(), [64, 177, 183], 'reopened on the OKLCH commit');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('Escape in the middle of a drag closes the picker without errors', async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await pickerPage(browser);
    for (const area of ['.rcp-sv', '.rcp-hue', '.rcp-alpha']) {
      await openOn(page, '#40b1b7');
      const box = (await page.locator(area).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2, { steps: 3 });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => window.RadialColorPicker.isOpen()), false, `${area}: Escape closes the picker`);
      // The pointer is still captured: these moves reach the drag's listener.
      await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 3 });
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.committed.at(-1)), null, `${area}: Escape commits nothing`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
