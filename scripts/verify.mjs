import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const reportArg = process.argv[2];
if (!reportArg || reportArg.startsWith('--')) {
  console.error('Usage: node verify.mjs <report.html> [--playwright <installed-playwright/index.mjs>] [--channel chrome|msedge]');
  process.exit(2);
}
const html = resolve(reportArg);
const argIndex = process.argv.indexOf('--playwright');
let packagePath = argIndex >= 0 ? process.argv[argIndex + 1] : process.env.REPO_ATLAS_PLAYWRIGHT_PATH;
const channelIndex = process.argv.indexOf('--channel');
const requestedChannel = channelIndex >= 0 ? process.argv[channelIndex + 1] : process.env.REPO_ATLAS_BROWSER_CHANNEL;
if (requestedChannel && !['chrome', 'msedge'].includes(requestedChannel)) throw new Error('--channel must be chrome or msedge');
if (!packagePath) {
  const require = createRequire(import.meta.url);
  for (const candidate of ['playwright', 'playwright-core']) {
    try { packagePath = require.resolve(candidate, { paths: [process.cwd(), dirname(html)] }); break; }
    catch {}
  }
  if (!packagePath) throw new Error('Playwright is not installed/resolvable. Pass --playwright or REPO_ATLAS_PLAYWRIGHT_PATH. No dependencies were downloaded.');
}
const playwright = await import(pathToFileURL(resolve(packagePath)).href);
const chromium = playwright.chromium || playwright.default?.chromium;
if (!chromium) throw new Error('The supplied package does not export Playwright chromium');
async function launchBrowser() {
  if (requestedChannel) return { browser: await chromium.launch({ headless: true, channel: requestedChannel }), channel: requestedChannel };
  try { return { browser: await chromium.launch({ headless: true }), channel: 'bundled-chromium' }; }
  catch (initialError) {
    const failures = [String(initialError)];
    for (const channel of ['chrome', 'msedge']) {
      try { return { browser: await chromium.launch({ headless: true, channel }), channel }; }
      catch (error) { failures.push(`${channel}: ${error}`); }
    }
    throw new Error(`No usable Chromium browser found. Install the matching Playwright browser or pass --channel. Attempts:\n${failures.join('\n')}`);
  }
}
const launched = await launchBrowser();
const browser = launched.browser;
const artifactDirectory = resolve(dirname(html), basename(html, '.html') + '.verification');
await mkdir(artifactDirectory, { recursive: true });
const result = { report: html, browser: launched.channel, status: 'running', diagrams: [], checks: [], mobile: [], errors: [] };
const errors = [];
const externalRequests = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await page.waitForFunction(() => window.repoAtlas && ['ready', 'error'].includes(document.getElementById('graph-viewport').dataset.renderState));
  const data = await page.evaluate(() => window.repoAtlas.data);
  assert.equal(await page.title(), data.project.title);
  assert.equal(Number(await page.locator('#stat-modules').textContent()), data.stats.modules);
  assert.equal(Number(await page.locator('#stat-chains').textContent()), data.stats.chains || data.chains?.length || 0);
  assert.equal(Number(await page.locator('#stat-evidence').textContent()), data.stats.evidence);
  if (data.chains?.length) {
    assert.ok(await page.locator('#chain-section').isVisible(), 'chain directory is hidden');
    assert.equal(await page.locator('.chain-card').count(), data.chains.length);
    const chain = data.chains[0];
    await page.locator(`[data-chain="${chain.id}"]`).first().click();
    const chainText = await page.locator('#dialog-body').innerText();
    assert.ok(chainText.includes(chain.title) || chainText.includes(chain.summary), 'chain details are missing');
    assert.equal(await page.locator('.chain-stage').count(), chain.stages.length);
    await page.locator(`[data-chain-source="${chain.id}"]`).first().click();
    assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0, 'chain evidence is missing');
    await page.locator('#close-dialog').click();
    result.checks.push('chain directory / stage coverage / chain evidence');
  }
  if (data.update) {
    const summary = data.update.summary || {};
    assert.ok(await page.locator('#update-button').isVisible(), 'incremental update button is hidden');
    await page.locator('#update-button').click();
    const updateText = await page.locator('#dialog-body').innerText();
    assert.ok(updateText.includes(String(summary.changedFiles || 0)), 'update dialog omitted changed file count');
    assert.ok(updateText.includes(String(summary.staleEvidence || data.update.staleEvidence?.length || 0)), 'update dialog omitted stale evidence count');
    assert.ok(updateText.includes(String(summary.reusedEvidence || 0)), 'update dialog omitted reused evidence count');
    assert.ok(updateText.includes(String(summary.recomputedEvidence || 0)), 'update dialog omitted recomputed evidence count');
    await page.locator('#close-dialog').click();
    result.checks.push('incremental update chip / changed files / stale evidence');
  }
  const diagrams = data.views.filter(view => view.diagram);
  for (const view of diagrams) {
    await page.evaluate(id => window.repoAtlas.navigate(id), view.id);
    assert.equal(await page.locator('#graph-viewport').getAttribute('data-render-state'), 'ready', view.id + ' failed');
    const info = await page.locator('#graph-stage svg').evaluate(svg => ({ width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height, labels: svg.querySelectorAll('text, foreignObject').length }));
    assert.ok(info.width > 0 && info.height > 0 && info.labels > 0, 'empty SVG: ' + view.id);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow: ' + view.id);
    result.diagrams.push({ id: view.id, ...info });
  }
  const screenshotIds = new Set([diagrams[0].id, [...result.diagrams].sort((a, b) => b.width - a.width)[0].id, [...result.diagrams].sort((a, b) => b.height - a.height)[0].id]);
  for (const id of screenshotIds) {
    await page.evaluate(id => window.repoAtlas.navigate(id), id);
    await page.screenshot({ path: resolve(artifactDirectory, 'desktop-' + id + '.png'), fullPage: true });
  }
  await page.evaluate(id => window.repoAtlas.navigate(id), diagrams[0].id);
  const initial = Number(await page.locator('#zoom-input').inputValue());
  await page.locator('#zoom-in').click();
  assert.ok(Number(await page.locator('#zoom-input').inputValue()) > initial);
  await page.locator('#zoom-out').click();
  await page.locator('#zoom-input').fill('125');
  await page.locator('#zoom-input').press('Tab');
  assert.equal(Number(await page.locator('#zoom-input').inputValue()), 125);
  await page.locator('#fit-graph').click();
  assert.equal(Number(await page.locator('#zoom-input').inputValue()), initial);
  const viewportBox = await page.locator('#graph-viewport').boundingBox();
  const before = await page.evaluate(() => window.repoAtlas.camera);
  await page.mouse.move(viewportBox.x + 10, viewportBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 100, viewportBox.y + 65, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.repoAtlas.camera);
  assert.ok(before.x !== after.x && before.y !== after.y, 'drag did not move');
  await page.locator('#fit-graph').click();
  result.checks.push('zoom / pan / fit');

  const module = data.modules[0];
  await page.locator('#module-search').fill(module.name);
  await page.locator(`[data-search-module="${module.id}"]`).click();
  assert.ok(await page.locator('#detail-dialog').isVisible());
  await page.locator(`[data-evidence-module="${module.id}"]`).first().click();
  assert.equal(await page.locator('#dialog-body pre').textContent(), module.sources[0].excerpt);
  const sourceHref = await page.locator('#dialog-body a').getAttribute('href');
  await readFile(new URL(sourceHref, pathToFileURL(html)), 'utf8');
  await page.locator('#close-dialog').click();
  await page.locator('#module-search').fill('UNLIKELY_QUERY_NO_MATCH_0914');
  assert.ok((await page.locator('#search-results').innerText()).includes('没有匹配'));
  await page.locator('#module-search').fill('');
  result.checks.push('search / evidence excerpt / relative source link / empty search');

  const firstNode = page.locator('#graph-stage [data-module]').first();
  if (await firstNode.count()) {
    await firstNode.click();
    assert.ok(await page.locator('#detail-dialog').isVisible());
    await page.locator('#close-dialog').click();
    result.checks.push('clickable flowchart node');
  }
  const evidencedView = diagrams.find(view => view.sources?.length);
  if (evidencedView) {
    await page.evaluate(id => window.repoAtlas.navigate(id), evidencedView.id);
    await page.locator('#show-view-evidence').click();
    await page.locator('[data-direct-source]').first().click();
    assert.equal(await page.locator('#dialog-body pre').textContent(), evidencedView.sources[0].excerpt);
    await page.locator('#close-dialog').click();
    result.checks.push('view-level evidence');
  }
  if (data.findings.length) {
    const finding = data.findings[0];
    await page.locator('#module-search').fill(finding.title);
    await page.locator(`[data-finding="${finding.id}"]`).first().click();
    assert.ok((await page.locator('#dialog-body').innerText()).includes(finding.summary));
    await page.locator(`[data-finding-source="${finding.id}"]`).first().click();
    assert.equal(await page.locator('#dialog-body pre').textContent(), finding.sources[0].excerpt);
    await page.locator('#close-dialog').click();
    await page.locator('#module-search').fill('');
    result.checks.push('finding search / evidence');
  }
  if (data.coverage.length) {
    const coverage = data.coverage[0];
    await page.locator('#module-search').fill(coverage.area);
    await page.locator(`[data-coverage="${coverage.id}"]`).first().click();
    assert.ok((await page.locator('#dialog-body').innerText()).includes(coverage.summary));
    await page.locator('#close-dialog').click();
    await page.locator('#module-search').fill('');
    result.checks.push('coverage search');
  }
  const searchedView = diagrams.at(-1);
  await page.locator('#module-search').fill(searchedView.title);
  await page.locator(`[data-search-view="${searchedView.id}"]`).click();
  assert.equal(await page.evaluate(() => window.repoAtlas.currentView), searchedView.id);
  await page.locator('#module-search').fill('');
  result.checks.push('view search / navigation');
  await page.locator('#show-source').click();
  assert.equal(await page.locator('#dialog-body pre').textContent(), searchedView.diagram);
  const mmdPromise = page.waitForEvent('download');
  await page.locator('#download-mermaid').click();
  const mmd = await mmdPromise;
  assert.equal(await readFile(await mmd.path(), 'utf8'), searchedView.diagram);
  await page.locator('#close-dialog').click();
  const svgPromise = page.waitForEvent('download');
  await page.locator('#export-svg').click();
  const svg = await svgPromise;
  const exported = await readFile(await svg.path(), 'utf8');
  assert.ok(exported.includes('<svg') && exported.includes('viewBox'));
  result.checks.push('Mermaid source / MMD download / SVG download');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  result.checks.push('fullscreen');

  await page.evaluate(() => window.repoAtlas.navigate('catalog'));
  for (const kind of ['chains', 'findings', 'coverage', 'tables', 'routes', 'files', 'flags']) {
    const tab = page.locator(`[data-catalog="${kind}"]`);
    if (!data[kind].length) { assert.ok(!(await tab.isVisible()), 'empty index tab should be hidden'); continue; }
    await tab.click();
    assert.equal(await page.locator('#catalog-body tr').count(), data[kind].length);
    const query = kind === 'chains' || kind === 'findings' ? data[kind][0].title : kind === 'routes' ? data[kind][0].prefix : kind === 'coverage' ? data[kind][0].area : data[kind][0].name;
    await page.locator('#catalog-search').fill(query);
    assert.ok(!(await page.locator('#catalog-body .empty-row').count()));
    if (kind === 'chains') {
      await page.locator('#catalog-body [data-chain]').first().click();
      assert.equal(await page.locator('.chain-stage').count(), data.chains[0].stages.length);
      await page.locator(`[data-chain-source="${data.chains[0].id}"]`).first().click();
      assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0);
      await page.locator('#close-dialog').click();
    } else if (['routes', 'flags'].includes(kind)) {
      await page.locator('#catalog-body button').first().click();
      await page.locator('[data-index-source]').first().click();
      assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0);
      await page.locator('#close-dialog').click();
    } else if (kind === 'findings') {
      await page.locator('#catalog-body [data-finding]').first().click();
      await page.locator('[data-finding-source]').first().click();
      assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0);
      await page.locator('#close-dialog').click();
    } else if (kind === 'coverage') {
      await page.locator('#catalog-body [data-coverage]').first().click();
      assert.ok(await page.locator('#detail-dialog').isVisible());
      await page.locator('#close-dialog').click();
    } else if (kind === 'tables') {
      await page.locator('#catalog-body [data-table]').first().click();
      await page.locator('[data-table-source]').first().click();
      assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0);
      await page.locator('#close-dialog').click();
    }
    await page.locator('#catalog-search').fill('');
  }
  const preferredCatalog = data.findings.length ? 'findings' : data.coverage.length ? 'coverage' : ['tables', 'routes', 'files', 'flags'].find(kind => data[kind].length);
  if (preferredCatalog) await page.locator(`[data-catalog="${preferredCatalog}"]`).click();
  await page.screenshot({ path: resolve(artifactDirectory, 'desktop-catalog.png'), fullPage: true });
  const unnamedButtons = await page.locator('button:visible').evaluateAll(buttons => buttons.filter(button => !(button.getAttribute('aria-label') || button.textContent.trim())).length);
  assert.equal(unnamedButtons, 0, 'visible button without accessible name');
  result.checks.push('actual index counts / filters / optional index sections / accessible buttons');
  await page.locator('#about-button').click();
  assert.ok((await page.locator('#dialog-body').innerText()).includes(data.project.scope));
  await page.locator('#close-dialog').click();
  assert.equal(externalRequests.length, 0, 'page requested an external resource');
  result.checks.push('offline / no external requests');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, offline: true });
  const phone = await mobileContext.newPage();
  phone.on('pageerror', error => errors.push(String(error)));
  phone.on('request', request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); });
  await phone.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await phone.waitForFunction(() => window.repoAtlas && document.getElementById('graph-viewport').dataset.renderState === 'ready');
  for (const view of diagrams) {
    await phone.evaluate(id => window.repoAtlas.navigate(id), view.id);
    assert.equal(await phone.locator('#graph-viewport').getAttribute('data-render-state'), 'ready');
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (view.mobileDiagram) {
      await phone.locator('#show-source').click();
      assert.equal(await phone.locator('#dialog-body pre').textContent(), view.mobileDiagram);
      await phone.locator('#close-dialog').click();
    }
    result.mobile.push({ id: view.id, variant: !!view.mobileDiagram, noOverflow: true });
  }
  await phone.evaluate(id => window.repoAtlas.navigate(id), diagrams[0].id);
  await phone.screenshot({ path: resolve(artifactDirectory, 'mobile-overview.png'), fullPage: true });
  await phone.locator('#open-nav').click();
  await phone.locator('[data-view="catalog"]').click();
  assert.ok(!(await phone.locator('#sidebar').isVisible()));
  await phone.screenshot({ path: resolve(artifactDirectory, 'mobile-catalog.png'), fullPage: true });
  await phone.setViewportSize({ width: 320, height: 740 });
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await phone.evaluate(id => window.repoAtlas.navigate(id), diagrams[0].id);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  result.checks.push('mobile 390px / 320px / navigation / diagram variants');
  assert.equal(externalRequests.length, 0);
  assert.deepEqual(errors, [], 'browser errors');
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.errors = [...errors, String(error)];
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(resolve(artifactDirectory, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
}
console.log(JSON.stringify({ ...result, artifacts: artifactDirectory }, null, 2));
