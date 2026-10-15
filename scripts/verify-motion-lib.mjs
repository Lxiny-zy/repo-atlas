// Browser checks for illustrative flow motion, using the real rendered SVG geometry.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function verifyFlowMotion(page, artifacts, checks) {
  const go = async (id, mode) => {
    await page.evaluate(({ id, mode }) => window.repoAtlas.navigate(id, true, { mode }), { id, mode });
    assert.equal(await page.locator('#graph-viewport').getAttribute('data-render-state'), 'ready');
  };
  const waitState = state => page.waitForFunction(state => document.getElementById('graph-viewport').dataset.flowState === state, state);
  const positions = () => page.locator('.flow-particle').evaluateAll(nodes => nodes.map(node => [node.getAttribute('cx'), node.getAttribute('cy')]));
  const sample = () => page.evaluate(() => {
    const layer = document.querySelector('.flow-particles:not([style*="display: none"])');
    const path = layer.previousElementSibling, particle = layer.querySelector('.flow-particle');
    const x = particle.cx.baseVal.value, y = particle.cy.baseVal.value, length = path.getTotalLength();
    let distance = 0, error = Infinity;
    for (let value = 0; value <= length; value += .5) {
      const point = path.getPointAtLength(value), delta = Math.hypot(x - point.x, y - point.y);
      if (delta < error) { error = delta; distance = value; }
    }
    return { distance, length, error, time: performance.now() };
  });
  const advances = async () => {
    const before = await sample();
    await page.waitForTimeout(280);
    const after = await sample();
    const travel = (after.distance - before.distance + before.length) % before.length;
    assert.ok(before.error < 1 && after.error < 1, 'particles must stay on the actual curved path');
    assert.ok(travel > 2 && travel < (after.time - before.time) * .08 + 2, 'motion must advance along the arrow without duplicate animation loops');
  };
  const staysStill = async () => {
    const before = await positions();
    await page.waitForTimeout(180);
    assert.deepEqual(await positions(), before, 'suspended or paused particles must not move');
  };
  const checkBindings = async expected => {
    const bindings = await page.evaluate(() => {
      const data = window.repoAtlas.data;
      const nodes = [...document.querySelectorAll('#graph-stage [data-module]')];
      const near = (point, node) => {
        const r = node.getBoundingClientRect();
        return Math.hypot(Math.max(r.left - point.x, 0, point.x - r.right), Math.max(r.top - point.y, 0, point.y - r.bottom));
      };
      return [...document.querySelectorAll('.flow-particles')].map(layer => {
        const path = layer.previousElementSibling, row = data.relations.find(row => row.id === layer.dataset.flowRelation);
        const from = nodes.find(node => node.dataset.module === row.from), to = nodes.find(node => node.dataset.module === row.to);
        const point = distance => {
          const p = path.getPointAtLength(distance), svg = path.ownerSVGElement, box = svg.getBoundingClientRect();
          // WebKit's getScreenCTM omits ancestor CSS scale. Compose the SVG and viewport transforms.
          const local = new DOMPoint(p.x, p.y).matrixTransform(path.getCTM());
          return { x: box.x + local.x * box.width / svg.width.baseVal.value, y: box.y + local.y * box.height / svg.height.baseVal.value };
        };
        const start = point(0), end = point(path.getTotalLength());
        return {
          id: row.id, kind: row.kind, edge: path.dataset.relationId,
          startsAtProvider: near(start, from) < near(start, to), endsAtReceiver: near(end, to) < near(end, from),
          ignoresPointer: getComputedStyle(layer).pointerEvents === 'none'
        };
      });
    });
    assert.deepEqual(bindings.map(row => row.id).sort(), [...expected].sort());
    assert.ok(bindings.every(row => row.kind === 'data_flow' && row.id === row.edge && row.startsAtProvider && row.endsAtReceiver && row.ignoresPointer));
  };
  const flowIds = ['stock_input', 'stock_result', 'record_input', 'record_result'];

  await page.setViewportSize({ width: 1440, height: 1000 });
  await go('overview');
  await waitState('playing');
  assert.ok(await page.locator('#flow-playback').isVisible());
  await checkBindings(flowIds);
  await advances();
  await page.locator('#toggle-flow').press('Enter');
  await waitState('paused');
  await staysStill();
  await page.locator('#zoom-in').click();
  const anchored = await page.locator('.flow-particle').evaluateAll(nodes => nodes.every(node => {
    const svg = node.ownerSVGElement, viewport = svg.getBoundingClientRect();
    const local = new DOMPoint(node.cx.baseVal.value, node.cy.baseVal.value).matrixTransform(node.getCTM());
    const point = { x: viewport.x + local.x * viewport.width / svg.width.baseVal.value, y: viewport.y + local.y * viewport.height / svg.height.baseVal.value };
    const box = node.getBoundingClientRect();
    return Math.hypot(point.x - box.x - box.width / 2, point.y - box.y - box.height / 2) < 1;
  }));
  assert.ok(anchored, 'zoom must keep the markers in the same SVG coordinate space');
  await page.locator('#fit-graph').click();
  checks.push('flow particles follow SVG curves from provider to receiver; keyboard pause freezes positions and zoom preserves alignment');

  await go('overview', 'all');
  await waitState('paused');
  assert.equal(await page.locator('path.flowchart-link[data-relation-kind="dependency"]').count(), 0);
  assert.equal(await page.locator('path.flowchart-link[data-relation-kind="data_flow"]').count(), 4);
  await checkBindings(flowIds);
  await page.locator('#graph-stage [data-module="inventory"]').click();
  assert.deepEqual(await page.locator('.flow-particles.is-focused-flow').evaluateAll(nodes => nodes.map(node => node.dataset.flowRelation).sort()), ['stock_input', 'stock_result']);
  assert.equal(await page.locator('.flow-particles:visible').count(), 2);
  assert.match(await page.locator('#flow-status').innerText(), /2 \/ 4/);
  await page.locator('#toggle-flow').click();
  await waitState('playing');
  const muted = page.locator('.flow-particles:not(.is-focused-flow) .flow-particle');
  const mutedBefore = await muted.evaluateAll(nodes => nodes.map(node => node.outerHTML));
  await advances();
  assert.deepEqual(await muted.evaluateAll(nodes => nodes.map(node => node.outerHTML)), mutedBefore);
  await page.locator('#clear-focus').click();
  assert.equal(await page.locator('.flow-particles:visible').count(), 4);
  await page.evaluate(async () => { await Promise.all(['overview', 'place_order', 'overview', 'data_objects', 'overview'].map(id => window.repoAtlas.navigate(id))); });
  await waitState('playing');
  await checkBindings(flowIds);
  await advances();
  checks.push('only data-flow edges render; module focus animates related transfers, pause survives navigation and rapid view changes do not duplicate particles');

  const previousPadding = await page.evaluate(() => {
    const previous = document.body.style.paddingBottom;
    document.body.style.paddingBottom = '200vh';
    window.scrollTo(0, document.documentElement.scrollHeight);
    return previous;
  });
  await waitState('suspended');
  await staysStill();
  await page.evaluate(padding => { document.body.style.paddingBottom = padding; window.scrollTo(0, 0); }, previousPadding);
  await waitState('playing');
  // Exercise the same lifecycle event delivered when a browser tab becomes hidden.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitState('suspended');
  await staysStill();
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await waitState('playing');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitState('paused');
  await staysStill();
  // WebKit's offline transport rejects file navigation; the harness still blocks all HTTP requests.
  const webkitFile = page.context().browser().browserType().name() === 'webkit' && page.url().startsWith('file:');
  if (webkitFile) await page.context().setOffline(false);
  try { await page.reload(); }
  finally { if (webkitFile) await page.context().setOffline(true); }
  await page.waitForFunction(() => window.repoAtlas);
  await go('overview');
  await waitState('paused');
  assert.equal(await page.locator('#toggle-flow').getAttribute('aria-pressed'), 'false');
  await staysStill();
  await page.locator('#toggle-flow').click();
  await waitState('playing');
  await advances();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('offscreen and hidden-tab motion is suspended; reduced-motion applies on load and when preferences change, with explicit manual playback available');

  await page.setViewportSize({ width: 390, height: 844 });
  await go('overview');
  await waitState('playing');
  await checkBindings(flowIds);
  await page.locator('#reader-tab').click();
  await waitState('suspended');
  await staysStill();
  await page.locator('#diagram-tab').click();
  await waitState('playing');
  await advances();
  await page.locator('#graph-section').screenshot({ path: resolve(artifacts, 'dynamic-data-flow-mobile.png') });
  checks.push('mobile diagrams keep the declared flow direction and stop background motion while reading the other pane');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await go('overview');
  await waitState('playing');
  await page.locator('#graph-section').screenshot({ path: resolve(artifacts, 'dynamic-data-flow.png') });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-svg').click();
  const download = await downloadPromise;
  const exportPath = resolve(artifacts, 'static-data-flow.svg');
  await download.saveAs(exportPath);
  const svg = await readFile(exportPath, 'utf8');
  const exported = await page.evaluate(content => {
    const svg = new DOMParser().parseFromString(content, 'image/svg+xml');
    return { errors: svg.querySelectorAll('parsererror').length, edges: svg.querySelectorAll('path.flowchart-link[marker-end]').length, particles: svg.querySelectorAll('.flow-particles, animate, animateMotion').length };
  }, svg);
  assert.deepEqual(exported, { errors: 0, edges: 4, particles: 0 });
  await page.emulateMedia({ media: 'print' });
  await waitState('suspended');
  await staysStill();
  assert.ok(await page.locator('#flow-playback').isHidden());
  // Hidden SVG children retain bounds in WebKit; check the layer that suppresses painting.
  assert.equal(await page.locator('.flow-particles:visible').count(), 0);
  assert.equal(await page.locator('path.flowchart-link').count(), 4);
  await page.emulateMedia({ media: 'screen' });
  await waitState('playing');
  for (const view of ['data_objects', 'place_order', 'catalog']) {
    await go(view);
    assert.equal(await page.locator('.flow-particles').count(), 0);
    assert.ok(await page.locator('#flow-playback').isHidden());
  }
  await go('overview');
  checks.push('SVG export and print preserve static arrows without motion overlays; ER, authored process diagrams and catalog remain static');
}
