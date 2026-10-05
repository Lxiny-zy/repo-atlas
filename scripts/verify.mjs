import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions } from './cli-lib.mjs';

const options = parseOptions(process.argv.slice(2), { value: ['playwright', 'browser', 'channel'], usage: 'Usage: node scripts/verify.mjs <report.html> [--playwright installed-playwright/index.mjs] [--browser chromium|firefox|webkit] [--channel chrome|msedge]' });
const reportArg = options._[0];
const html = resolve(reportArg);
let packagePath = options.playwright || process.env.REPO_ATLAS_PLAYWRIGHT_PATH;
const requestedChannel = options.channel || process.env.REPO_ATLAS_BROWSER_CHANNEL;
const requestedBrowser = options.browser || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(requestedBrowser)) throw new Error('--browser must be chromium, firefox or webkit');
if (requestedChannel && requestedBrowser !== 'chromium') throw new Error('--channel applies only to chromium');
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
  if (requestedBrowser !== 'chromium') return { browser: await (playwright[requestedBrowser] || playwright.default?.[requestedBrowser]).launch({ headless: true }), channel: requestedBrowser };
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
const artifactDirectory = resolve(dirname(html), basename(html, '.html') + '.verification', ...(options.browser ? [requestedBrowser] : []));
await mkdir(artifactDirectory, { recursive: true });
const result = { report: html, browser: launched.channel, status: 'running', diagrams: [], checks: [], mobile: [], layout: [], errors: [] };
const errors = [];
const externalRequests = [];
// WebKit can fail local navigation when offline emulation is already on.
// Block HTTP throughout, load the real file, then enable offline emulation.
const delayedOffline = requestedBrowser === 'webkit';
const documentUrl = pathToFileURL(html).href;
result.documentTransport = 'file';
result.offlineEmulation = delayedOffline ? 'after local file navigation; HTTP blocked throughout' : 'before navigation';
async function openReport(page, hash = '') {
  if (delayedOffline) {
    await page.context().setOffline(false);
    await page.route(/^https?:/, route => route.abort());
  }
  await page.goto(documentUrl + hash, { waitUntil: 'load' });
  if (delayedOffline) await page.context().setOffline(true);
}
const trackRequest = request => { if (/^https?:/.test(request.url())) externalRequests.push(request.url()); };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, offline: true, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', event => { if (event.type() === 'error') errors.push(event.text()); });
  page.on('request', trackRequest);
  await openReport(page);
  await page.waitForFunction(() => window.repoAtlas && ['ready', 'error'].includes(document.getElementById('graph-viewport').dataset.renderState));
  const data = await page.evaluate(() => window.repoAtlas.data);
  if (data.reviewMode) {
    assert.ok(await page.locator('#review-banner').isVisible());
    assert.ok((await page.locator('#review-banner').innerText()).includes('仅供复核'));
    const sources = [...data.modules, ...data.views, ...data.chains, ...data.chains.flatMap(chain => chain.stages), ...data.findings, ...data.coverage, ...data.tables, ...data.routes, ...data.flags].flatMap(row => row.sources || []);
    const missing = sources.find(source => source.state === 'unresolved');
    if (missing) {
      await page.evaluate(key => { location.hash = new URLSearchParams({ evidence: key }).toString(); }, missing.key);
      await page.waitForFunction(() => document.getElementById('detail-dialog').open);
      assert.equal(await page.locator('#dialog-title').innerText(), '证据未解析');
      assert.ok((await page.locator('#dialog-body').innerText()).includes(missing.path));
      assert.equal(await page.locator('#dialog-body pre').count(), 0, 'unresolved evidence must not masquerade as an excerpt');
      assert.equal(await page.locator('.source-anchor').count(), 0);
      await page.screenshot({ path: resolve(artifactDirectory, 'unresolved-evidence.png') });
      await page.locator('#close-dialog').click();
    }
    await page.setViewportSize({ width: 320, height: 740 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(artifactDirectory, 'review-mobile.png'), fullPage: true });
    result.checks.push('review-only banner / unresolved evidence without invented excerpt or line / 320px layout');
  } else {
  const overviewId = (data.views.find(view => view.kind === 'overview' || view.id === 'overview') || data.views[0]).id;
  await page.evaluate(id => window.repoAtlas.navigate(id), overviewId);
  result.layout.push(await page.evaluate(() => ({ view: window.repoAtlas.currentView, width: innerWidth, contentTop: Math.round(document.querySelector('#graph-section:not([hidden]), #sequence-section:not([hidden])').getBoundingClientRect().top) })));
  assert.equal(await page.title(), data.project.title);
  assert.equal(Number(await page.locator('#stat-modules').textContent()), data.stats.modules);
  assert.equal(Number(await page.locator('#stat-chains').textContent()), data.stats.chains || data.chains?.length || 0);
  assert.equal(Number(await page.locator('#stat-evidence').textContent()), data.stats.evidence);
  if (data.chains?.length) {
    assert.ok(await page.locator('#chain-section').isVisible(), 'chain directory is hidden');
    assert.equal(await page.locator('.chain-card').count(), Math.min(12, data.chains.length));
    const chain = data.chains[0];
    await page.locator(`[data-chain="${chain.id}"]`).first().click();
    const chainText = await page.locator('#dialog-body').innerText();
    assert.ok(chainText.includes(chain.title) || chainText.includes(chain.summary), 'chain details are missing');
    assert.equal(await page.locator('.chain-stage').count(), chain.stages.length);
    const stageWithEvidence = chain.stages.find(stage => stage.sources?.length);
    if (stageWithEvidence) {
      await page.locator(`[data-chain-stage-source="${chain.id}"][data-stage="${stageWithEvidence.id}"]`).first().click();
      assert.ok((await page.locator('#dialog-body pre').innerText()).length > 0, 'stage evidence is missing');
      await page.screenshot({ path: resolve(artifactDirectory, 'desktop-evidence.png') });
      await page.locator('#dialog-back').click();
      assert.equal(await page.locator('.chain-stage').count(), chain.stages.length, 'return from evidence lost the chain');
    }
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
  const diagrams = data.views.filter(view => view.diagram && view.kind !== 'sequence');
  const narratives = data.views.filter(view => ['sequence', 'narrative'].includes(view.kind) || /^\s*sequenceDiagram\b/.test(view.diagram || ''));
  for (const view of narratives) {
    await page.evaluate(id => window.repoAtlas.navigate(id), view.id);
    assert.ok(await page.locator('#sequence-section').isVisible(), view.id + ' flow narrative is hidden');
    assert.ok((await page.locator('#sequence-list').innerText()).length > 0, view.id + ' flow narrative is empty');
    if (view.id !== overviewId) {
      assert.ok(!(await page.locator('#chain-section').isVisible()), 'flow page repeated the global directory');
      assert.ok(!(await page.locator('#summary-strip').isVisible()), 'flow page repeated global statistics');
    }
    result.checks.push('readable flow narrative: ' + view.id);
  }
  const testedChain = data.chains?.slice(0, 12).find(chain => chain.readingView && chain.stages.length >= 3);
  if (testedChain) {
    const cases = [
      { statuses: ['covered', 'covered', 'unknown'], badge: 'partial', covered: false, review: false, text: '2/3 个适用阶段已覆盖' },
      { statuses: ['covered', 'covered', 'not_applicable'], badge: 'covered', covered: true, review: false, text: '2/2 个适用阶段已覆盖' },
      { statuses: ['partial', 'unknown', 'not_applicable'], badge: 'partial', covered: false, review: false, text: '0/2 个适用阶段已覆盖' },
      { statuses: ['not_applicable', 'not_applicable', 'not_applicable'], badge: 'not_applicable', covered: false, review: false, text: '无适用阶段' },
      { statuses: ['covered', 'covered', 'covered'], badge: 'covered', covered: true, review: true, text: '3/3 个适用阶段已覆盖' }
    ];
    try {
      for (const sample of cases) {
        await page.evaluate(({ original, sample }) => {
          const chain = structuredClone(original);
          delete chain.freshness; delete chain.reviewRequired;
          chain.stages = sample.statuses.map((status, index) => ({ ...chain.stages[index], status, freshness: sample.review && index === 0 ? 'stale' : 'fresh', reviewRequired: false }));
          const data = window.repoAtlas.data;
          data.chains[data.chains.findIndex(row => row.id === chain.id)] = chain;
        }, { original: testedChain, sample });
        await page.evaluate(id => window.repoAtlas.navigate(id), testedChain.readingView);
        const card = page.locator(`[data-narrative-chain="${testedChain.id}"]`);
        assert.equal(await card.locator(`.sequence-card-head .status-${sample.badge}`).count(), 1);
        assert.equal(await card.locator('.sequence-card-head .status-stale').count(), sample.review ? 1 : 0);
        assert.ok((await card.locator('.chain-coverage-summary').innerText()).includes(sample.text));
        await page.evaluate(id => window.repoAtlas.navigate(id), overviewId);
        await page.locator('#chain-filter').selectOption('covered');
        assert.equal(await page.locator(`#chain-grid [data-chain="${testedChain.id}"]`).count(), sample.covered ? 1 : 0);
        await page.locator('#chain-filter').selectOption('review');
        assert.equal(await page.locator(`#chain-grid [data-chain="${testedChain.id}"]`).count(), sample.review ? 1 : 0);
      }
    } finally {
      await page.evaluate(original => { const data = window.repoAtlas.data; data.chains[data.chains.findIndex(row => row.id === original.id)] = original; }, testedChain);
      await page.evaluate(id => window.repoAtlas.navigate(id), overviewId);
      await page.locator('#chain-filter').selectOption('all');
    }
    await page.locator(`[data-chain-reading="${testedChain.id}"]`).first().click();
    assert.equal(await page.evaluate(() => window.repoAtlas.currentView), testedChain.readingView);
    if (testedChain.readingView !== overviewId) {
      await page.goBack();
      await page.waitForFunction(id => window.repoAtlas.currentView === id, overviewId);
      await page.goForward();
      await page.waitForFunction(id => window.repoAtlas.currentView === id, testedChain.readingView);
    }
    const stageButton = page.locator(`[data-stage-evidence="${testedChain.id}"]`).first();
    if (await stageButton.count()) {
      await stageButton.click();
      const sourceButtons = await page.locator('[data-direct-source]').count();
      await page.locator('[data-direct-source]').first().click();
      assert.equal(await page.locator('.source-anchor').count(), 1);
      await page.locator('#dialog-back').click();
      assert.equal(await page.locator('[data-direct-source]').count(), sourceButtons);
      await page.locator('[data-direct-source]').last().click();
      assert.ok((await page.locator('.source-code').textContent()).length > 0, 'return lost the source collection');
      await page.locator('#close-dialog').click();
    }
    result.checks.push('coverage aggregation / not-applicable denominator / stage freshness / direct evidence / dialog return / browser history');
  }
  for (const view of diagrams) {
    await page.evaluate(id => window.repoAtlas.navigate(id), view.id);
    assert.equal(await page.locator('#graph-viewport').getAttribute('data-render-state'), 'ready', view.id + ' failed');
    const info = await page.locator('#graph-stage svg').evaluate(svg => ({ width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height, labels: svg.querySelectorAll('text, foreignObject').length }));
    assert.ok(info.width > 0 && info.height > 0 && info.labels > 0, 'empty SVG: ' + view.id);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow: ' + view.id);
    result.diagrams.push({ id: view.id, ...info });
  }
  const screenshotIds = diagrams.length ? new Set([diagrams[0].id, [...result.diagrams].sort((a, b) => b.width - a.width)[0].id, [...result.diagrams].sort((a, b) => b.height - a.height)[0].id]) : new Set();
  for (const id of screenshotIds) {
    await page.evaluate(id => window.repoAtlas.navigate(id), id);
    await page.screenshot({ path: resolve(artifactDirectory, 'desktop-' + id + '.png'), fullPage: true });
  }
  if (diagrams.length) {
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
  }

  const module = data.modules[0];
  await page.locator('#module-search').fill(module.name);
  await page.locator(`[data-search-module="${module.id}"]`).click();
  assert.ok(await page.locator('#detail-dialog').isVisible());
  const technical = page.locator('#dialog-body [data-technical-evidence]');
  assert.equal(await technical.getAttribute('open'), null, 'source locations should be opt-in');
  await technical.locator('summary').click();
  await page.locator(`[data-evidence-module="${module.id}"]`).first().click();
  assert.equal(await page.locator('#dialog-body pre').textContent(), module.sources[0].excerpt);
  const sourceHref = await page.locator('#dialog-body a').getAttribute('href');
  await readFile(new URL(sourceHref, pathToFileURL(html)), 'utf8');
  await page.locator('#close-dialog').click();
  await page.locator('#module-search').fill('UNLIKELY_QUERY_NO_MATCH_0914');
  assert.ok((await page.locator('#search-results').innerText()).includes('没有匹配'));
  await page.locator('#module-search').fill('');
  result.checks.push('search / evidence excerpt / relative source link / empty search');

  const authoredSource = data.modules.find(item => item.links?.some(id => data.modules.some(moduleRow => moduleRow.id === id)));
  const authoredTarget = authoredSource ? data.modules.find(item => item.id === authoredSource.links.find(id => data.modules.some(moduleRow => moduleRow.id === id))) : null;
  if (authoredSource && authoredTarget) {
    await page.evaluate(({ view, focus, reach }) => { location.hash = '#' + new URLSearchParams({ view, focus, reach }).toString(); }, { view: overviewId, focus: authoredSource.id, reach: 'downstream' });
    // Search already selected this module. Its ID alone can satisfy the wait
    // before the asynchronous hash navigation has restored the inline detail.
    await page.locator('#module-detail').waitFor({ state: 'visible' });
    await page.waitForFunction(id => window.repoAtlas.selectedModule === id, authoredSource.id);
    assert.ok(await page.locator('#module-detail').isVisible(), 'module focus detail is hidden');
    assert.ok(await page.locator('.module-passport').isVisible(), 'relationship passport is hidden');
    assert.equal(new URLSearchParams(new URL(await page.evaluate(() => location.href)).hash.slice(1)).get('focus'), authoredSource.id);
    await page.evaluate(() => { window.__copiedFocusLink = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedFocusLink = value; } } }); });
    await page.locator('.module-copy-link').click();
    const copiedFocus = await page.evaluate(() => window.__copiedFocusLink);
    assert.equal(new URLSearchParams(new URL(copiedFocus).hash.slice(1)).get('focus'), authoredSource.id);
    assert.equal(new URLSearchParams(new URL(copiedFocus).hash.slice(1)).get('reach'), 'downstream');
    assert.ok(await page.locator(`[data-focus-module="${authoredTarget.id}"]`).count(), 'downstream authored link is missing');
    await page.locator(`[data-focus-module="${authoredTarget.id}"]`).first().click();
    assert.equal(await page.evaluate(() => window.repoAtlas.selectedModule), authoredTarget.id);
    assert.equal(new URLSearchParams(new URL(await page.evaluate(() => location.href)).hash.slice(1)).get('focus'), authoredTarget.id);

    await page.evaluate(({ view, route }) => { location.hash = '#' + new URLSearchParams({ view, route }).toString(); }, { view: overviewId, route: authoredSource.id + '~' + authoredTarget.id });
    await page.waitForFunction(() => document.getElementById('detail-dialog').open && document.querySelectorAll('.authored-route li').length >= 2);
    assert.ok((await page.locator('#dialog-body').innerText()).includes('协作路径'));
    assert.ok(!(await page.locator('#dialog-body').innerText()).includes('modules.links'));
    assert.equal(new URLSearchParams(new URL(await page.evaluate(() => location.href)).hash.slice(1)).get('route'), authoredSource.id + '~' + authoredTarget.id);
    await page.locator('#close-dialog').click();
    result.checks.push('authored relationship passport / stable focus hash / finite route reading');
  }

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
  const searchedView = diagrams.at(-1) || narratives.at(-1);
  await page.locator('#module-search').fill(searchedView.title);
  await page.locator(`[data-search-view="${searchedView.id}"]`).click();
  assert.equal(await page.evaluate(() => window.repoAtlas.currentView), searchedView.id);
  await page.locator('#module-search').fill('');
  result.checks.push('view search / navigation');
  if (diagrams.length) {
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
  }

  await page.evaluate(() => window.repoAtlas.navigate('catalog'));
  assert.ok(await page.locator('#catalog-section').evaluate(section => section.getBoundingClientRect().top < innerHeight / 2), 'evidence index is below global content');
  result.layout.push(await page.evaluate(() => ({ view: 'catalog', width: innerWidth, contentTop: Math.round(document.getElementById('catalog-section').getBoundingClientRect().top) })));
  for (const kind of ['chains', 'findings', 'coverage', 'tables', 'routes', 'files', 'flags']) {
    const tab = page.locator(`[data-catalog="${kind}"]`);
    if (!data[kind].length) { assert.ok(!(await tab.isVisible()), 'empty index tab should be hidden'); continue; }
    await tab.click();
    assert.equal(await page.locator('#catalog-body tr').count(), Math.min(50, data[kind].length));
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

  if (data.review && !data.update) {
    assert.equal(await page.locator('#update-label').innerText(), '已复核');
    await page.locator('#update-button').click();
    assert.ok((await page.locator('#dialog-body').innerText()).includes(data.review.reviewer));
    assert.ok((await page.locator('#dialog-body').innerText()).includes(data.review.version));
    await page.locator('#close-dialog').click();
    result.checks.push('accepted version / reviewer / review timestamp');
  }
  const linkedChain = data.chains.find(chain => chain.readingView && chain.stages.some(stage => stage.sources?.[0]?.key));
  if (linkedChain) {
    const stage = linkedChain.stages.find(stage => stage.sources?.[0]?.key);
    const source = stage.sources[0];
    const detailPage = await context.newPage();
    detailPage.on('pageerror', error => errors.push(String(error)));
    detailPage.on('request', trackRequest);
    const route = { view: linkedChain.readingView, chain: linkedChain.id, stage: stage.id, evidence: source.key };
    await openReport(detailPage, '#' + new URLSearchParams(route));
    await detailPage.waitForFunction(() => window.repoAtlas && document.getElementById('detail-dialog').open);
    assert.equal(await detailPage.locator('#dialog-body pre').textContent(), source.excerpt);
    assert.ok(await detailPage.locator('#copy-detail-link').isVisible());
    // Check copy output through clipboard or the selectable offline fallback.
    await detailPage.evaluate(() => { window.__copiedLink = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copiedLink = value; } } }); });
    await detailPage.locator('#copy-detail-link').click();
    const copied = await detailPage.evaluate(() => window.__copiedLink);
    assert.equal(new URLSearchParams(new URL(copied).hash.slice(1)).get('evidence'), source.key);
    await detailPage.locator('#dialog-back').click();
    assert.ok((await detailPage.locator('#dialog-body').innerText()).includes(linkedChain.summary));
    await detailPage.locator('#close-dialog').click();
    const stageRoute = { view: linkedChain.readingView, chain: linkedChain.id, stage: stage.id };
    await detailPage.evaluate(hash => { location.hash = hash; }, '#' + new URLSearchParams(stageRoute));
    await detailPage.waitForFunction(() => document.querySelector('.is-target'));
    assert.equal(await detailPage.locator('.is-target').getAttribute('data-stage-anchor'), `${linkedChain.id}/${stage.id}`);
    await detailPage.locator('.is-target [data-copy-stage]').click();
    assert.equal(new URLSearchParams(new URL(await detailPage.evaluate(() => window.__copiedLink)).hash.slice(1)).get('stage'), stage.id);
    await detailPage.evaluate(() => { location.hash = '#view=missing&chain=missing&stage=missing'; });
    await detailPage.waitForFunction(() => document.getElementById('toast').textContent.includes('定位目标不存在'));
    await detailPage.goBack();
    await detailPage.waitForFunction(() => document.querySelector('.is-target'));
    await detailPage.close();
    result.checks.push('direct evidence URL / copied detail and stage links / stage target / invalid fragment / history restoration');
  }

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(requestedBrowser === 'firefox' ? {} : { isMobile: true }), hasTouch: true, offline: true });
  const phone = await mobileContext.newPage();
  phone.on('pageerror', error => errors.push(String(error)));
  phone.on('request', trackRequest);
  await openReport(phone);
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
  const mobileStart = diagrams[0] || narratives[0];
  await phone.evaluate(id => window.repoAtlas.navigate(id), mobileStart.id);
  await phone.screenshot({ path: resolve(artifactDirectory, 'mobile-overview.png'), fullPage: true });
  await phone.locator('#open-nav').click();
  await phone.locator('[data-view="catalog"]').click();
  assert.ok(!(await phone.locator('#sidebar').isVisible()));
  await phone.screenshot({ path: resolve(artifactDirectory, 'mobile-catalog.png'), fullPage: true });
  await phone.setViewportSize({ width: 320, height: 740 });
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await phone.evaluate(id => window.repoAtlas.navigate(id), mobileStart.id);
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  for (const view of narratives) {
    await phone.evaluate(id => window.repoAtlas.navigate(id), view.id);
    assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile narrative overflow');
    assert.ok(await phone.locator('#sequence-section').evaluate(section => section.getBoundingClientRect().top < innerHeight), 'mobile flow starts below the first screen');
    result.layout.push(await phone.evaluate(() => ({ view: window.repoAtlas.currentView, width: innerWidth, contentTop: Math.round(document.getElementById('sequence-section').getBoundingClientRect().top) })));
  }
  if (narratives.length) await phone.screenshot({ path: resolve(artifactDirectory, 'mobile-flow.png'), fullPage: true });
  result.checks.push('mobile 390px / 320px / navigation / diagram variants');
  // A larger in-memory delivery exercises pagination beyond the small fixture.
  await page.evaluate(() => {
    const data = window.repoAtlas.data;
    data.files = Array.from({ length: 125 }, (_, index) => ({ path: `src/generated-${index}.js`, name: `generated-${index}.js`, group: 'Pagination fixture', lines: 8, line: 1 }));
    if (data.chains.length) data.chains = Array.from({ length: 25 }, (_, index) => ({ ...structuredClone(data.chains[0]), id: `pagination_${index}`, title: `Pagination chain ${index}` }));
  });
  await page.evaluate(() => window.repoAtlas.navigate('catalog'));
  await page.locator('[data-catalog="files"]').evaluate(button => { button.hidden = false; button.click(); });
  assert.equal(await page.locator('#catalog-body tr').count(), 50);
  await page.locator('#catalog-pages button').last().click();
  assert.ok((await page.locator('#catalog-body').innerText()).includes('generated-50.js'));
  await page.locator('#catalog-pages button').last().click();
  assert.equal(await page.locator('#catalog-body tr').count(), 25);
  assert.ok(await page.locator('#catalog-pages button').last().isDisabled());
  await page.locator('#catalog-search').fill('generated-124.js');
  assert.equal(await page.locator('#catalog-body tr').count(), 1);
  assert.ok(!(await page.locator('#catalog-pages').isVisible()));
  await page.locator('#catalog-search').fill('');
  assert.ok((await page.locator('#catalog-body').innerText()).includes('generated-0.js'));
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'pagination overflow at 320px');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (data.chains.length) {
    await page.evaluate(id => window.repoAtlas.navigate(id), overviewId);
    await page.locator('#chain-filter').selectOption('all');
    assert.equal(await page.locator('#chain-grid .chain-card').count(), 12);
    await page.locator('#chain-pages button').last().click();
    assert.ok((await page.locator('#chain-grid').innerText()).includes('Pagination chain 12'));
    await page.locator('#chain-pages button').last().click();
    assert.equal(await page.locator('#chain-grid .chain-card').count(), 1);
    await page.locator('#chain-filter').selectOption('review');
    await page.locator('#chain-filter').selectOption('all');
    assert.ok((await page.locator('#chain-grid').innerText()).includes('Pagination chain 0'));
  }
  await page.evaluate(() => {
    window.repoAtlas.data.update = { reviewRequired: true, unmappedChanges: [{ path: 'src/unassigned.js', status: 'modified' }], staleEvidence: Array.from({ length: 21 }, (_, index) => ({ entity: `module:review_${index}`, path: 'src/sample.js', reason: 'source changed' })) };
    document.getElementById('update-button').hidden = false;
  });
  await page.locator('#update-button').click();
  assert.ok((await page.locator('#dialog-body').innerText()).includes('src/unassigned.js'));
  assert.ok((await page.locator('#dialog-body').innerText()).includes('module:review_20'));
  await page.locator('#close-dialog').click();

  result.checks.push('125-file catalog / 25-chain pagination / filter resets / 320px pager / unmapped review queue / complete stale list');
  }
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
