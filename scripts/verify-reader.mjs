// Human reading journeys: explore architecture; follow evidence only when requested.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { parseOptions } from './cli-lib.mjs';
import { verifyFlowMotion } from './verify-motion-lib.mjs';

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
if (engine !== 'webkit') await context.setOffline(true);
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const result = { browser: engine, status: 'failed', checks: [], layout: [], errors, externalRequests: external };
const go = async id => {
  await page.evaluate(id => window.repoAtlas.navigate(id), id);
  assert.equal(await page.locator('#graph-viewport').getAttribute('data-render-state'), 'ready', id);
};
const noCode = async () => {
  assert.equal(await page.locator('main pre').count(), 0, 'source blocks must not occupy the human report');
  assert.doesNotMatch(await page.locator('main').innerText(), /export function|reserveStock\(|saveOrder\(/);
};
const shot = async (name, fullPage = false) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: resolve(artifacts, name + '.png'), fullPage });
};
try {
  await page.goto(pathToFileURL(report).href);
  if (engine === 'webkit') await context.setOffline(true);
  await page.waitForFunction(() => window.repoAtlas);
  const provenance = await page.evaluate(() => window.repoAtlas.data.fingerprint);
  if (provenance) {
    await page.locator('#about-button').click();
    const metadata = await page.locator('#dialog-body').innerText();
    for (const field of ['toolVersion', 'generatedAt', 'toolSha256', 'manifestSha256', 'analysisManifestSha256', 'sourceSha256']) assert.ok(metadata.includes(provenance[field]), field);
    await page.locator('#close-dialog').press('Enter');
    assert.ok((await page.locator('#footer-baseline').innerText()).includes(provenance.analysisManifestSha256.slice(0, 8)));
    result.checks.push('visible version fingerprints and generation time; keyboard dismissal returns to report');
  }
  await go('overview');
  await noCode();
  assert.equal(await page.locator('#graph-stage [data-module]').count(), 3);
  assert.equal(await page.locator('#graph-stage path.flowchart-link').count(), 4);
  assert.equal(await page.locator('#graph-stage path.LS-atlas_orders.LE-atlas_inventory').count(), 1, 'request data flows from orders to inventory');
  assert.equal(await page.locator('[data-relation-mode], #relation-switch').count(), 0, 'data flow is the only module connection view');
  assert.equal(await page.locator('#graph-stage path[data-relation-kind="dependency"]').count(), 0);
  assert.ok(await page.locator('#read-dataflow').isVisible());
  assert.ok(await page.locator('#read-structures').isVisible());
  await page.locator('#read-dataflow').click();
  assert.equal(await page.evaluate(() => window.repoAtlas.currentView), 'overview', 'the data-flow entry reuses the architecture diagram');
  await page.evaluate(() => window.scrollTo(0, 0));
  const positions = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect().top;
    return [r('project-intro'), r('graph-section'), r('chain-section'), r('findings-section')];
  });
  assert.ok(positions.every((top, index) => index === 0 || top > positions[index - 1]));
  await shot('overview-first-screen');
  await shot('overview', true);
  result.checks.push('architecture is primary, source blocks absent, visual entry points precede supporting text');

  await page.locator('#graph-stage [data-module="inventory"]').click();
  assert.equal(await page.locator('#reading-panel').getAttribute('data-subject'), 'inventory');
  assert.ok(await page.locator('#graph-stage [data-module="records"]').evaluate(node => node.classList.contains('is-muted')));
  assert.equal(await page.locator('#graph-stage path.is-focused-edge').count(), 2);
  assert.equal(await page.locator('.relation-dependency').count(), 0, 'module details should explain input and output without duplicate dependency lists');
  const input = page.locator('[data-relation-id="stock_input"] .relation-direction [data-focus-architecture]');
  assert.deepEqual(await input.evaluateAll(nodes => nodes.map(node => node.dataset.focusArchitecture)), ['orders', 'inventory']);
  const output = page.locator('[data-relation-id="stock_result"] .relation-direction [data-focus-architecture]');
  assert.deepEqual(await output.evaluateAll(nodes => nodes.map(node => node.dataset.focusArchitecture)), ['inventory', 'orders']);
  assert.match(await page.locator('[data-relation-id="stock_input"] .payload-list').innerText(), /商品编号/);
  assert.equal(await page.locator('#graph-stage path.is-focused-edge').count(), 2);
  assert.equal(await page.locator('#graph-stage path.LS-atlas_inventory.LE-atlas_orders').count(), 1, 'reservation result must flow from inventory back to orders');
  assert.equal(await page.locator('#graph-stage .is-muted-label').count(), 2, 'unrelated data-flow labels should recede with their edges');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).has('mode'), false);
  for (const [mode, focus] of [['dependency', 'orders'], ['all', 'inventory'], ['data_flow', 'orders']]) {
    await page.evaluate(({ mode, focus }) => { location.hash = new URLSearchParams({ view: 'overview', mode, focus }).toString(); }, { mode, focus });
    await page.waitForFunction(focus => document.getElementById('reading-panel').dataset.subject === focus && document.getElementById('graph-viewport').dataset.renderState === 'ready', focus);
    assert.equal(await page.locator('#graph-stage path.flowchart-link').count(), 4, 'legacy mode links must resolve to data flow');
  }
  await page.locator('#graph-stage [data-module="inventory"]').click();
  await noCode();
  await shot('data-flow', true);
  result.checks.push('only data delivery is shown, with request/return directions, payloads and neighbor highlights; legacy mode links retain module focus');

  const fileLink = page.locator('#reader-body > .reader-evidence .source-reference').first();
  const fileUrl = new URL(await fileLink.getAttribute('href'), pathToFileURL(report));
  assert.match(fileUrl.hash, /^#L\d+$/);
  fileUrl.hash = '';
  assert.match(await readFile(fileUrl, 'utf8'), /reserveStock/);
  await page.locator('#reader-body > .reader-evidence .evidence-reference').first().click();
  assert.match(await page.locator('#dialog-body pre').innerText(), /reserveStock/);
  await page.locator('#close-dialog').click();
  assert.equal(await page.locator('#reading-panel').getAttribute('data-subject'), 'inventory');
  await noCode();
  result.checks.push('source evidence is a real file hyperlink plus an optional offline excerpt; no persistent code pane');

  await page.locator('[data-relation-id="stock_input"] [data-focus-architecture="orders"]').click();
  assert.equal(await page.locator('#reading-panel').getAttribute('data-subject'), 'orders');
  await page.locator('#reader-body [data-focus-table="orders"]').click();
  await page.waitForFunction(() => window.repoAtlas.currentView === 'data_objects' && document.getElementById('reading-panel').dataset.subject === 'orders' && document.getElementById('graph-viewport').dataset.renderState === 'ready');
  assert.equal(await page.locator('#graph-stage [data-object]').count(), 2, 'ER aliases must bind original entity labels, not sanitized DOM IDs');
  assert.equal(await page.locator('.field-table tbody tr').count(), 4);
  assert.match(await page.locator('#reader-body').innerText(), /非数据库表/);
  assert.match(await page.locator('.field-reference').innerText(), /逻辑关联/);
  await shot('data-objects', true);
  await page.locator('.field-reference [data-focus-table="available"]').click();
  assert.equal(await page.locator('.field-table tbody tr').count(), 2);
  assert.ok(await page.locator('#graph-stage [data-object="available"]').evaluate(node => node.classList.contains('is-selected')));
  await noCode();
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('reading-panel').dataset.subject === 'orders');
  result.checks.push('modules connect to interactive ER objects, typed fields and explicit logical references; table history restores selection');

  await go('place_order');
  await page.locator('#graph-stage [data-diagram-node="stock"]').click();
  assert.equal(await page.locator('#reading-panel').getAttribute('data-subject'), 'purchase/stock');
  assert.match(await page.locator('.reader-summary').innerText(), /库存足够/);
  assert.equal(await page.locator('#graph-stage .is-selected[data-graph-stage="stock"]').count(), 2);
  await noCode();
  await shot('purchase', true);
  await page.locator('#reader-body [data-focus-architecture="inventory"]').click();
  await page.waitForFunction(() => window.repoAtlas.currentView === 'overview' && window.repoAtlas.selectedModule === 'inventory');
  await page.goBack();
  await page.waitForFunction(() => window.repoAtlas.currentView === 'place_order' && document.getElementById('reading-panel').dataset.subject === 'purchase/stock');
  await page.locator('#graph-stage [data-diagram-node="payment"]').focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#reader-body').innerText(), /不能据此认定顾客已经付款/);
  assert.equal(await page.locator('#reader-body .source-reference').count(), 0);
  await go('order_states');
  assert.match(await page.locator('#graph-stage').innerText(), /待处理/);
  assert.match(await page.locator('#graph-stage').innerText(), /已取消/);
  result.checks.push('process branches explain business effects, link back to module architecture and keep unknown behavior separate');

  await verifyFlowMotion(page, artifacts, result.checks);

  for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [1100, 760], [1024, 760], [960, 760], [921, 760], [920, 760], [800, 740], [641, 740], [640, 740], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    for (const view of ['overview', 'place_order', 'cancel_order', 'order_states', 'data_objects']) {
      await go(view);
      await noCode();
      const layout = await page.evaluate(() => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
        const toolbar = box('.graph-actions');
        return {
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          graph: box('#graph-section'), reader: box('#reading-panel'), header: box('.app-header'), title: box('#view-title'), copy: box('#copy-view-link'), stages: box('#stage-nav'),
          controlsFit: [...document.querySelectorAll('.graph-actions button')].filter(button => !button.hidden).every(button => { const r = button.getBoundingClientRect(); return r.left >= toolbar.left - 1 && r.right <= toolbar.right + 1; }),
          playbackFits: document.getElementById('flow-playback').hidden || [...document.querySelectorAll('#flow-playback > *')].every(node => { const r = node.getBoundingClientRect(), container = box('#flow-playback'); return r.left >= container.left - 1 && r.right <= container.right + 1; })
        };
      });
      assert.ok(!layout.overflow && layout.controlsFit && layout.playbackFits, width + '/' + view + ': overflow');
      const overlap = Math.min(layout.title.right, layout.copy.right) - Math.max(layout.title.left, layout.copy.left) > 1 && Math.min(layout.title.bottom, layout.copy.bottom) - Math.max(layout.title.top, layout.copy.top) > 1;
      assert.ok(!overlap && layout.stages.height <= 150, width + '/' + view + ': heading or stage navigation');
      if (width > 920) {
        assert.ok(layout.reader.left >= layout.graph.right && Math.abs(layout.reader.top - layout.graph.top) < 2);
        assert.ok(layout.reader.height <= height - layout.header.height - 30);
      } else {
        await page.locator('#reader-tab').click();
        assert.ok(await page.locator('#reading-panel').isVisible());
        await page.locator('#reader-tab').press('ArrowLeft');
        assert.ok(await page.locator('#graph-section').isVisible());
      }
      if (view === 'data_objects') assert.equal(await page.locator('#graph-stage [data-object]').count(), 2);
      result.layout.push({ width, height, view, passed: true });
    }
  }
  result.checks.push('65 layout cases across five visual views and 320–1920px; compact tabs and ER bindings remain usable');

  await page.setViewportSize({ width: 1280, height: 720 });
  await go('overview');
  const node = page.locator('#graph-stage [data-module="inventory"]');
  await node.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => scrollY);
  await node.click();
  assert.ok(Math.abs(await page.evaluate(() => scrollY) - before) < 2);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.locator('#reader-tab').click();
  assert.equal(await page.locator('#reading-panel').getAttribute('data-subject'), 'inventory');
  await noCode();
  await shot('mobile-relations');
  await page.locator('#diagram-tab').click();
  await page.locator('#graph-section').screenshot({ path: resolve(artifacts, 'mobile-architecture.png') });
  await page.locator('#open-nav').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.getElementById('nav-backdrop').hidden);
  assert.ok(await page.locator('#main-content').evaluate(element => element.getBoundingClientRect().top < 100));
  result.checks.push('node selection avoids page jumps; responsive changes retain focus and clear navigation backdrops');

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  result.status = 'passed';
} catch (error) {
  errors.push(String(error)); process.exitCode = 1;
  await shot('failure', true).catch(() => {});
} finally {
  await browser.close();
  await writeFile(resolve(artifacts, 'result.json'), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
