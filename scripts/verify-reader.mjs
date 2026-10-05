// End-to-end reader journeys against the authored Chinese demonstration.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { parseOptions } from './cli-lib.mjs';

const options = parseOptions(process.argv.slice(2), {
  value: ['browser'], usage: 'Usage: node scripts/verify-reader.mjs <order-journey/report.html> [--browser chromium|firefox|webkit]'
});
const engine = options.browser || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('Unsupported browser');
const report = resolve(options._[0]);
const artifacts = resolve(dirname(report), 'reader.verification', engine);
await mkdir(artifacts, { recursive: true });
const browser = await ({ chromium, firefox, webkit })[engine].launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const external = [], errors = [];
await context.route(/^https?:\/\//, route => { external.push(route.request().url()); return route.abort(); });
const deferredOffline = process.platform === 'win32' && engine === 'webkit';
if (!deferredOffline) await context.setOffline(true);
const page = await context.newPage();
page.on('pageerror', error => errors.push(String(error)));
const result = { browser: engine, status: 'failed', checks: [], errors, externalRequests: external };
try {
  await page.goto(pathToFileURL(report).href);
  if (deferredOffline) await context.setOffline(true);
  await page.waitForFunction(() => window.repoAtlas?.currentView === 'overview');
  assert.match(await page.locator('#project-summary').innerText(), /顾客提交购买/);
  assert.equal(await page.locator('.reading-boundary').getAttribute('open'), null);
  assert.ok(await page.locator('#read-flows').isVisible());
  assert.ok(await page.locator('#read-findings').isVisible());
  const positions = await page.evaluate(() => Object.fromEntries(['project-intro', 'chain-section', 'findings-section', 'graph-section'].map(id => [id, document.getElementById(id).getBoundingClientRect().top])));
  assert.ok(positions['project-intro'] < positions['chain-section']);
  assert.ok(positions['chain-section'] < positions['findings-section']);
  assert.ok(positions['findings-section'] < positions['graph-section']);
  assert.doesNotMatch(await page.locator('main').innerText(), /modules\.links|authored relationship|submitOrder|reserveStock/);
  await page.screenshot({ path: resolve(artifacts, 'overview.png'), fullPage: true });
  result.checks.push('business summary and reading choices precede flows, conclusions and diagrams');

  await page.locator('#read-flows').click();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '业务如何运转');
  await page.locator('[data-chain-reading="purchase"]').first().click();
  await page.waitForFunction(() => window.repoAtlas.currentView === 'place_order');
  assert.match(await page.locator('.sequence-summary').innerText(), /预留库存/);
  assert.equal(await page.locator('.sequence-step-title .chain-stage-kind').count(), 0);
  assert.match(await page.locator('[data-stage-anchor="purchase/payment"]').innerText(), /不能据此认定顾客已经付款/);
  assert.match(await page.locator('[data-stage-anchor="purchase/payment"] .next-question').innerText(), /支付接入/);
  await page.screenshot({ path: resolve(artifacts, 'purchase.png'), fullPage: true });
  result.checks.push('business stages explain outcomes and preserve unconfirmed payment boundary');

  await page.locator('[data-stage-evidence="purchase"][data-stage="stock"]').click();
  await page.locator('[data-direct-source]').first().click();
  assert.match(await page.locator('.source-code').innerText(), /reserveStock/);
  await page.locator('#dialog-back').click();
  assert.ok(await page.locator('[data-direct-source]').count() > 0);
  await page.locator('#close-dialog').click();
  await page.locator('#overview-link').click();
  await page.locator('.module-row[data-module="orders"]').click();
  assert.match(await page.locator('#module-detail .summary').innerText(), /协调取消后的库存返还/);
  assert.equal(await page.locator('#module-detail [data-technical-evidence]').getAttribute('open'), null);
  assert.doesNotMatch(await page.locator('#module-detail').innerText(), /src\/orders\.js|authored|modules\.links/);
  await page.locator('#module-detail [data-technical-evidence] summary').click();
  await page.locator('#module-detail [data-evidence-module="orders"]').first().click();
  assert.match(await page.locator('.source-code').innerText(), /submitOrder/);
  await page.locator('#close-dialog').click();
  result.checks.push('technical identifiers stay behind evidence disclosure and source navigation remains usable');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => window.repoAtlas.navigate('overview'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.locator('#read-findings').click();
    assert.match(await page.locator('#finding-highlights').innerText(), /不会长期保存/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(artifacts, `mobile-overview-${width}.png`), fullPage: true });
    await page.locator('[data-chain-reading="purchase"]').first().click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(Number.parseFloat(await page.locator('.sequence-steps p').first().evaluate(element => getComputedStyle(element).fontSize)) >= 14);
    await page.screenshot({ path: resolve(artifacts, `mobile-flow-${width}.png`), fullPage: true });
  }
  result.checks.push('390px and 320px reading order, findings, body text size and overflow');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  result.status = 'passed';
} catch (error) {
  errors.push(String(error)); process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
