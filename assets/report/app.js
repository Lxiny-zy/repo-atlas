(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('graph-data').textContent);
  data.findings ||= [];
  data.coverage ||= [];
  data.chains ||= [];
  data.relations ||= [];
  data.update ||= null;
  const dataFlows = data.relations.filter(row => row.kind === 'data_flow');
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = name => `<i data-lucide="${esc(name)}"></i>`;
  const icons = () => window.lucide.createIcons();
  const byId = id => data.modules.find(module => module.id === id);
  for (const module of data.modules) module.links ||= [];
  const moduleLinkIds = module => [...new Set(dataFlows.length
    ? dataFlows.filter(row => row.from === module?.id).map(row => row.to)
    : [...(module?.links || []), ...data.relations.filter(row => row.kind === 'dependency' && row.from === module?.id).map(row => row.to)])].filter(id => byId(id));
  const byTable = name => data.tables.find(table => table.name === name);
  function authoredNeighbors(id, direction) {
    if (direction === 'upstream') return data.modules.filter(module => moduleLinkIds(module).includes(id));
    return moduleLinkIds(byId(id)).map(linkId => byId(linkId)).filter(Boolean);
  }
  function authoredRoute(sourceId, targetId) {
    if (!byId(sourceId) || !byId(targetId)) return null;
    if (sourceId === targetId) return [sourceId];
    const queue = [[sourceId]];
    const visited = new Set([sourceId]);
    while (queue.length) {
      const path = queue.shift();
      for (const next of moduleLinkIds(byId(path.at(-1)))) {
        if (visited.has(next)) continue;
        const nextPath = [...path, next];
        if (next === targetId) return nextPath;
        visited.add(next);
        queue.push(nextPath);
      }
    }
    return null;
  }
  const routePair = value => {
    const separator = String(value || '').indexOf('~');
    if (separator <= 0 || separator === String(value || '').length - 1) return null;
    return [String(value).slice(0, separator), String(value).slice(separator + 1)];
  };
  const fileUrl = path => data.sourceBase.split('/').map(encodeURIComponent).join('/') + path.split('/').map(encodeURIComponent).join('/');
  const sourceLocation = source => source.line == null ? '未解析' : 'L' + source.line;
  const basename = path => path.split('/').pop();
  const stage = $('graph-stage');
  const viewport = $('graph-viewport');
  const dialog = $('detail-dialog');
  let current = null;
  let selectedModule = null;
  let selectedStage = null;
  let selectedTable = null;
  let visualPane = 'diagram';
  let renderSerial = 0;
  let renderQueue = Promise.resolve();
  let flowRoutes = [];
  let flowFrame = null;
  let flowLastTime = null;
  let flowElapsed = 0;
  let flowPreference = null;
  let flowInView = true;
  let printing = false;
  let diagramSize = { width: 1000, height: 600 };
  let camera = { x: 0, y: 0, scale: 1 };
  let fitMode = true;
  const catalogKinds = ['chains', 'findings', 'coverage', 'tables', 'routes', 'files', 'flags'].filter(kind => data[kind].length > 0);
  let catalogMode = catalogKinds[0] || 'tables';
  let chainFilter = 'all';
  let catalogPage = 0;
  let chainPage = 0;
  const catalogPageSize = 50;
  const chainPageSize = 12;
  const searchIndex = new WeakMap();
  for (const kind of ['views', 'modules', ...catalogKinds]) {
    for (const row of data[kind]) searchIndex.set(row, JSON.stringify(row).toLowerCase());
  }
  const matchesSearch = (row, query) => {
    if (!searchIndex.has(row)) searchIndex.set(row, JSON.stringify(row).toLowerCase());
    return searchIndex.get(row).includes(query);
  };
  function renderPager(id, page, total, size, target) {
    const pages = Math.max(1, Math.ceil(total / size));
    $(id).hidden = pages <= 1;
    $(id).innerHTML = `<button type="button" data-page-target="${target}" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span role="status" aria-live="polite">第 ${page + 1} / ${pages} 页 · ${Math.min(total, page * size + 1)}–${Math.min(total, (page + 1) * size)} / ${total} 项</span><button type="button" data-page-target="${target}" data-page="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button>`;
  }
  let toastTimer;
  let moved = false;
  let sourceForCopy = '';
  let renderedDiagram = '';
  const cache = new Map();
  const dialogHistory = [];
  const overviewId = (data.views.find(view => view.kind === 'overview' || view.id === 'overview') || data.views[0]).id;
  const evidenceTargets = new Map();
  for (const kind of ['modules', 'relations', 'views', 'chains', 'findings', 'coverage', 'tables', 'routes', 'flags']) {
    for (const row of data[kind]) {
      const view = kind === 'views' ? row.id : kind === 'chains' ? row.readingView : kind === 'relations' ? data.views.find(view => view.relations?.includes(row.id))?.id : kind === 'tables' ? data.views.find(view => view.tables?.includes(row.name))?.id : overviewId;
      for (const source of row.sources || []) if (source.key) evidenceTargets.set(source.key, { source, title: row.title || row.name || row.label, view: view || overviewId, ...(kind === 'chains' ? { chain: row.id } : {}) });
      if (kind === 'chains') for (const stage of row.stages) for (const source of stage.sources) if (source.key) evidenceTargets.set(source.key, { source, title: row.title + ' · ' + stage.label, view: row.readingView || overviewId, chain: row.id, stage: stage.id });
    }
  }
  const fragment = route => '#' + new URLSearchParams(Object.entries(route).filter(([, value]) => value != null)).toString();
  function shareUrl(route) { const url = new URL(location.href); url.hash = fragment(route); return url.href; }
  function updateReadingHash(route, replace = false) {
    const next = fragment(route);
    if (location.hash === next) return;
    (replace ? history.replaceState : history.pushState).call(history, null, '', next);
  }
  async function copyLink(route) {
    const url = shareUrl(route);
    try { await navigator.clipboard.writeText(url); showToast('链接已复制；分享报告后保留 # 后的定位片段。'); }
    catch {
      showDialog('复制定位链接', `<p>复制下方链接。分享离线报告时，可将 # 后的定位片段加到收件人的报告地址。</p><input class="share-link-input" aria-label="定位链接" readonly value="${esc(url)}">`);
      $('dialog-body').querySelector('input').select();
    }
  }
  const smallScreen = window.matchMedia('(max-width: 640px)');
  const compactLayout = window.matchMedia('(max-width: 920px)');
  const collapsedNavigation = window.matchMedia('(max-width: 1024px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const printMedia = window.matchMedia('print');
  const kindLabels = { fact: '事实', risk: '风险', gap: '缺口', decision: '决策' };
  const statusLabels = { confirmed: '已确认', inferred: '推断', unverified: '待验证', covered: '已覆盖', partial: '部分覆盖', unknown: '待确认', not_applicable: '不适用' };
  const statusBadge = (value, label = statusLabels[value] || value) => `<span class="status-badge status-${esc(value)}">${esc(label)}</span>`;
  const needsReview = row => Boolean(row?.reviewRequired || ['stale', 'unresolved', 'historical'].includes(row?.freshness) || row?.sources?.some(source => source.state === 'unresolved'));
  const freshnessBadge = row => needsReview(row) ? statusBadge('stale', { unresolved: '证据未解析', historical: '历史证据' }[row.freshness] || '待复核') : '';
  const stageKindLabels = { entry: '入口', authorization: '权限', validation: '校验', orchestration: '业务编排', read: '读取', write: '写入', side_effect: '外部副作用', publication: '发布', consume: '消费', outcome: '结果', recovery: '失败恢复', custom: '处理' };
  const stageKindLabel = stage => stageKindLabels[stage.kind || 'custom'] || '业务处理';
  const chainKindLabel = chain => ({ user_flow: '用户流程', event_flow: '事件处理', batch: '批处理', recovery: '失败恢复' }[chain.kind] || '业务流程');

  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base',
    themeCSS: '.edgeLabel rect { opacity: 1; }',
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    themeVariables: {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', fontSize: '14px',
      primaryColor: '#e5f2ef', primaryTextColor: '#24564f', primaryBorderColor: '#70a79e',
      secondaryColor: '#eaf0fa', secondaryTextColor: '#35527a', secondaryBorderColor: '#8fa9cd',
      tertiaryColor: '#fff2dd', tertiaryTextColor: '#77551b', tertiaryBorderColor: '#d6b478',
      lineColor: '#8797a4', textColor: '#34424d', mainBkg: '#eff3f5',
      nodeBorder: '#879aa7', clusterBkg: '#f8f9fa', clusterBorder: '#d9e0e5',
      edgeLabelBackground: '#ffffff', noteBkgColor: '#fff7e8', noteTextColor: '#756035',
      actorBkg: '#eef2f5', actorBorder: '#8fa1ae', actorTextColor: '#344955',
      signalColor: '#758a99', signalTextColor: '#3c5361', labelBoxBkgColor: '#f5f7f8',
      labelBoxBorderColor: '#aab8c1', labelTextColor: '#364c59', loopTextColor: '#364c59',
      activationBkgColor: '#e7eef5', activationBorderColor: '#afc0d1',
      attributeBackgroundColorOdd: '#ffffff', attributeBackgroundColorEven: '#f4f7f2',
      cScale0: '#dcece1', cScale1: '#e3ebf9', cScale2: '#faedcf',
      cScale3: '#f7e5df', cScale4: '#dfeeed', cScale5: '#eaede7',
      cScaleLabel0: '#2f573e', cScaleLabel1: '#385983', cScaleLabel2: '#806328',
      cScaleLabel3: '#815044', cScaleLabel4: '#386d66', cScaleLabel5: '#576551'
    },
    flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis', nodeSpacing: 24, rankSpacing: 44, padding: 15 },
    er: { useMaxWidth: false, layoutDirection: 'LR', minEntityWidth: 110, minEntityHeight: 40, entityPadding: 12, fontSize: 12 },
    mindmap: { useMaxWidth: false, padding: 16 },
    state: { useMaxWidth: false }
  });

  function showToast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
  }

  function showDialog(title, body, sources = null, route = null) {
    if (dialog.open) {
      dialogHistory.push({ title: $('dialog-title').textContent, nodes: [...$('dialog-body').childNodes], sources: dialog._directSources, route: dialog._route, scrollTop: dialog.scrollTop, focus: document.activeElement });
    } else {
      dialogHistory.length = 0;
    }
    $('dialog-title').textContent = title;
    $('dialog-body').innerHTML = body;
    dialog._directSources = sources;
    dialog._route = route;
    $('copy-detail-link').hidden = !route;
    $('dialog-back').hidden = !dialogHistory.length;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
    $('dialog-title').focus({ preventScroll: true });
    icons();
  }

  function backDialog() {
    const previous = dialogHistory.pop();
    if (!previous) return;
    $('dialog-title').textContent = previous.title;
    $('dialog-body').replaceChildren(...previous.nodes);
    dialog._directSources = previous.sources;
    dialog._route = previous.route;
    $('copy-detail-link').hidden = !previous.route;
    $('dialog-back').hidden = !dialogHistory.length;
    dialog.scrollTop = previous.scrollTop;
    if (previous.focus?.isConnected) previous.focus.focus({ preventScroll: true });
    else $('dialog-title').focus({ preventScroll: true });
  }

  function showEvidence(source, contextTitle = null) {
    if (!source) return;
    const context = contextTitle || (dialog.open ? $('dialog-title').textContent : current?.title);
    const target = evidenceTargets.get(source.key);
    const route = source.key ? { view: target?.view || current?.id || overviewId, chain: target?.chain, stage: target?.stage, evidence: source.key } : null;
    if (source.state === 'unresolved') {
      showDialog('证据未解析', `<p class="stale-note">当前源码依据未解析，不能作为已确认事实。</p><p><code>${esc(source.path)}</code></p><p>${esc(source.reason)}</p>`, null, route);
      return;
    }
    const lines = (source.excerpt || '此项为源码索引，完整内容见对应文件。').split('\n');
    const code = lines.map((line, index) => `<span class="source-line${index === 0 ? ' source-anchor' : ''}" data-line="${source.line + index}">${esc(line)}</span>`).join('\n');
    showDialog('源码依据', `<p class="source-context">${esc(context || '')}</p><p><code>${esc(source.path)}</code><br>起始行 <strong>${sourceLocation(source)}</strong> · 首行是证据锚点</p><pre class="source-code"><code>${code}</code></pre><a href="${fileUrl(source.path)}" target="_blank" rel="noopener">${icon('external-link')} 打开源码文件</a>`, null, route);
  }

  function showAbout() {
    showDialog('基线与证据范围', `<p>扫描日期：${esc(data.date)}。本文基于以下本地工作区；关系、状态和写入目标以源码为依据。</p>
      ${data.repositories.length ? data.repositories.map(repo => `<div class="baseline-row"><strong>${esc(repo.name)}</strong><code>${esc(repo.branch)} @ ${esc(repo.commit)}</code></div>`).join('') : '<p>未配置 Git 基线；源码证据按本次读取记录。</p>'}
      <h4>覆盖范围</h4><p>${esc(data.project.scope)}<br>${data.modules.length} 个职责模块、${data.stats.diagrams} 张关系图、${data.stats.evidence || 0} 个证据锚点、${data.stats.files} 个已索引源码文件。</p>
      <div class="baseline-row"><strong>分析结论</strong><span>${data.findings.length} 个发现项 / ${data.coverage.length} 个覆盖维度</span></div>
      ${data.scanGroups.map(group => `<div class="baseline-row"><strong>${esc(group.name)} / ${group.count} 文件</strong><span>${group.paths.map(esc).join('、')} / ${group.extensions.map(esc).join(' ')}<br>排除：${group.exclude.map(esc).join('、')}</span></div>`).join('')}
      <h4>验证边界</h4><p>${esc(data.project.boundary)}</p>
      <h4>工作区差异</h4><p>${data.repositories.length ? data.repositories.filter(repo => repo.dirty.length).map(repo => `${esc(repo.name)}：${repo.dirty.map(esc).join('；')}`).join('<br>') || '基线读取时未发现已跟踪文件的未提交改动。' : '未读取 Git 工作区状态。'}<br>Git 差异只统计已跟踪文件；新增报告文件不计入该摘要。</p>
      <h4>图表与文件</h4><p>${esc(data.renderer)} 与 Lucide 0.468.0 已内嵌，均不在打开时请求 CDN。代码摘录保存在本文中，源码链接使用相对路径。</p>`);
  }

  function showUpdate() {
    const update = data.update;
    if (!update && data.review) {
      showDialog('复核记录', `<p>复核人：${esc(data.review.reviewer)}</p><p>复核时间：${esc(data.review.reviewedAt)}</p><p>接受时间：${esc(data.review.acceptedAt)}</p><p>版本：<code>${esc(data.review.version)}</code></p><p>复核记录绑定到接受时的源码与清单版本。</p>`);
      return;
    }
    if (!update) return;
    const summary = update.summary || {};
    const stale = update.staleEvidence || [];
    const unmapped = update.unmappedChanges || [];
    const manifestChanged = Boolean(summary.manifestChanged);
    showDialog('快照后的增量变更', `<p>这是基于上次快照生成的增量候选，不代表所有结论已经重新确认。</p>
      <div class="baseline-row"><strong>变更文件</strong><span>${summary.changedFiles || 0}（新增 ${summary.added || 0} / 修改 ${summary.modified || 0} / 删除 ${summary.deleted || 0}${summary.renamed ? ` / 重命名 ${summary.renamed}` : ''}）</span></div>
      <div class="baseline-row"><strong>变更占比</strong><span>${Math.round((summary.changedFileRatio || 0) * 1000) / 10}%</span></div>
      <div class="baseline-row"><strong>受影响对象</strong><span>${summary.impactedEntities || update.impacted?.length || 0}</span></div>
      <div class="baseline-row"><strong>待复核证据</strong><span>${stale.length}</span></div>
      <div class="baseline-row"><strong>待确认归属</strong><span>${unmapped.length}</span></div>
      <div class="baseline-row"><strong>可复用证据</strong><span>${summary.reusedEvidence || 0}</span></div>
      <div class="baseline-row"><strong>需重新核对</strong><span>${summary.recomputedEvidence || 0}</span></div>
      <div class="baseline-row"><strong>清单变化</strong><span>${manifestChanged ? '是，需复核' : '否'}</span></div>
      <div class="baseline-row"><strong>全量重分析</strong><span>${summary.fullReanalysisRecommended ? '建议执行' : '当前不需要'}</span></div>
      ${summary.fullReanalysisReasons?.length ? `<div class="stale-note">${summary.fullReanalysisReasons.map(reason => esc(reason)).join('<br>')}</div>` : ''}
      ${stale.length ? `<details open><summary>待复核证据 · ${stale.length} 项</summary><ul>${stale.map(item => `<li>${esc(item.entity)} · ${esc(item.path)} · ${esc(item.reason)}</li>`).join('')}</ul></details>` : '<p>没有检测到失效证据。</p>'}
      ${unmapped.length ? `<details open><summary>待确认归属 · ${unmapped.length} 项</summary><p>这些文件发生了变化，尚未关联到模块或证据，需要确认影响范围。</p><ul>${unmapped.map(item => `<li><code>${esc(item.path)}</code> · ${esc(({ added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' })[item.status] || item.status)}</li>`).join('')}</ul></details>` : ''}
      <p class="update-note">候选文件：${esc(update.deltaPath || '未记录')}<br>基线：${esc(update.baseSnapshot || '未记录')}</p>`);
  }

  function viewChains(view) {
    if ((view.kind === 'overview' || view.id === 'overview') && !view.bindings?.length) return [];
    return data.chains.filter(chain => view.chainIds?.includes(chain.id) || chain.views?.includes(view.id));
  }

  function stageMapMarkup(chain) {
    return `<ol class="stage-map" data-narrative-chain="${chain.id}">${chain.stages.map((item, index) => `<li><button type="button" class="stage-stop stage-${esc(item.status)}" title="${esc(item.label)}" data-select-stage="${chain.id}" data-stage="${item.id}" data-stage-anchor="${chain.id}/${item.id}" aria-pressed="false"><span class="stage-number">${String(index + 1).padStart(2, '0')}</span><span class="stage-stop-copy"><strong>${esc(item.label)}</strong><small>${esc(stageKindLabel(item))} · ${esc(statusLabels[item.status])}${needsReview(item) ? ' · 待复核' : ''}</small></span></button></li>`).join('')}</ol>`;
  }

  function renderSequenceDescription(view, chainId) {
    const chains = viewChains(view);
    const chain = chains.find(item => item.id === chainId) || chains[0];
    $('flow-context').hidden = !chain;
    $('stage-nav').hidden = !chain || !view.diagram;
    $('sequence-section').hidden = Boolean(view.diagram);
    $('flow-context').innerHTML = chain ? `<div class="flow-context-heading">${chains.length > 1 ? `<label>业务流程 <select id="reader-chain" aria-label="选择当前图中的业务流程">${chains.map(item => `<option value="${item.id}" ${item.id === chain.id ? 'selected' : ''}>${esc(item.title)}</option>`).join('')}</select></label>` : `<span>${esc(chainKindLabel(chain))} · ${esc(chain.title)}</span>`}<div class="flow-status"><span class="chain-coverage-summary">${esc(chainProgressLabel(chain))}</span><span class="status-stack">${chainBadges(chain)}</span></div></div><div class="flow-endpoints"><div><small>触发条件</small><p>${esc(chain.trigger)}</p></div><span aria-hidden="true">→</span><div><small>处理结果</small><p>${esc(chain.outcome)}</p></div></div>` : '';
    $('stage-nav').innerHTML = chain && view.diagram ? `<p class="stage-nav-hint">选择环节，对照图与实现 <span>编号用于阅读定位，执行分支以图中连线为准</span></p>${stageMapMarkup(chain)}` : '';
    $('sequence-count').textContent = chain ? `${chain.stages.length} 个阶段` : '待补充';
    $('sequence-intro').textContent = '这里按报告整理顺序列出阶段；未提供流程图时，不推断执行连线。点击卡片查看处理条件与数据变化。';
    $('sequence-list').innerHTML = view.diagram ? '' : chain ? stageMapMarkup(chain) : `<p class="empty-state">${esc(view.subtitle || '尚未整理流程阶段。')}</p>`;
    return chain;
  }

  function sourceReferences(sources = []) {
    return sources.map(source => {
      const target = evidenceTargets.get(source.key);
      const href = fragment({ view: target?.view || current?.id || overviewId, chain: target?.chain, stage: target?.stage, evidence: source.key });
      return `<span class="source-reference-row">${source.state === 'unresolved' ? `<span class="source-unresolved">${esc(source.path)} · 未解析</span>` : `<a class="source-reference" href="${fileUrl(source.path)}#L${source.line}" target="_blank" rel="noopener">${esc(source.path)}:${sourceLocation(source)} ${icon('external-link')}</a>`}${source.key ? `<a class="evidence-reference" href="${esc(href)}" data-evidence-key="${esc(source.key)}">${source.state === 'unresolved' ? '待复核原因' : '摘录'}</a>` : ''}</span>`;
    }).join('');
  }

  function readerMarkup(title, label, body, sources) {
    $('reader-body').innerHTML = `<div class="reader-description"><div class="reader-heading"><span class="eyebrow">${esc(label)}</span><h4>${esc(title)}</h4></div>${body}</div>${sources?.length ? `<footer class="reader-evidence"><span>源码依据</span>${sourceReferences(sources)}</footer>` : ''}`;
    $('reader-tab').textContent = ({ module: '模块与数据流', table: '字段与关联', stage: '流程说明', overview: '架构导览' })[$('reading-panel').dataset.kind] || '图解说明';
    $('reading-panel').scrollTop = 0;
    icons();
  }

  function visibleRelations() {
    const generated = current?.relationDiagrams?.data_flow;
    const ids = generated?.relations || current?.relations;
    if (generated || ids?.length) return dataFlows.filter(row => ids.includes(row.id));
    return dataFlows.filter(row => current?.modules.includes(row.from) && current?.modules.includes(row.to));
  }

  function stopFlowFrame() {
    if (flowFrame !== null) cancelAnimationFrame(flowFrame);
    flowFrame = null;
    flowLastTime = null;
  }

  function clearFlowAnimation() {
    stopFlowFrame();
    flowRoutes = [];
    flowElapsed = 0;
    stage.querySelectorAll('.flow-particles').forEach(layer => layer.remove());
    $('flow-playback').hidden = true;
    viewport.dataset.flowState = 'unavailable';
  }

  function drawFlowParticles() {
    for (const route of flowRoutes) {
      if (!route.active) continue;
      route.particles.forEach((particle, index) => {
        // Constant illustrative speed; never infer execution order or throughput.
        const distance = (flowElapsed * .055 + route.length * (.15 + index / route.particles.length)) % route.length;
        const point = route.path.getPointAtLength(distance);
        particle.setAttribute('cx', point.x);
        particle.setAttribute('cy', point.y);
      });
    }
  }

  function canAnimateFlows() {
    return (flowPreference ?? !reducedMotion.matches) && flowRoutes.some(route => route.active)
      && !document.hidden && !printing && !printMedia.matches && flowInView
      && !(compactLayout.matches && visualPane === 'reader') && viewport.dataset.renderState === 'ready';
  }

  function animateFlows(timestamp) {
    flowFrame = null;
    if (!canAnimateFlows()) { syncFlowPlayback(); return; }
    if (flowLastTime !== null) flowElapsed += Math.min(64, timestamp - flowLastTime);
    flowLastTime = timestamp;
    drawFlowParticles();
    flowFrame = requestAnimationFrame(animateFlows);
  }

  function syncFlowPlayback() {
    const available = flowRoutes.length > 0;
    const active = flowRoutes.filter(route => route.active).length;
    const enabled = flowPreference ?? !reducedMotion.matches;
    const running = available && canAnimateFlows();
    $('flow-playback').hidden = !available;
    $('toggle-flow').disabled = !active;
    $('toggle-flow').setAttribute('aria-pressed', String(enabled));
    $('toggle-flow').title = reducedMotion.matches && !enabled ? '已按系统偏好减少动态效果，可手动播放' : enabled ? '暂停数据流动画' : '播放数据流动画';
    $('flow-toggle-label').textContent = enabled ? '暂停流动' : '播放流动';
    $('flow-pause-icon').hidden = !enabled;
    $('flow-play-icon').hidden = enabled;
    $('flow-status').textContent = selectedModule ? `${active} / ${flowRoutes.length} 条关联数据流` : `${flowRoutes.length} 条数据流`;
    viewport.dataset.flowState = !available ? 'unavailable' : !enabled ? 'paused' : running ? 'playing' : 'suspended';
    if (running) {
      if (flowFrame === null) flowFrame = requestAnimationFrame(animateFlows);
    } else stopFlowFrame();
  }

  function syncFlowSelection() {
    for (const route of flowRoutes) {
      const related = route.relation.from === selectedModule || route.relation.to === selectedModule;
      route.active = !selectedModule || related;
      route.layer.style.display = route.active ? '' : 'none';
      route.layer.classList.toggle('is-focused-flow', Boolean(selectedModule && related));
    }
    drawFlowParticles();
    syncFlowPlayback();
  }

  function prepareFlowAnimation(svg, variant) {
    const relations = new Map(visibleRelations().map(row => [row.id, row]));
    const paths = new Map([...svg.querySelectorAll('path.flowchart-link')].map(path => [path.id, path]));
    for (const binding of variant?.edgeBindings || []) {
      const relation = relations.get(binding.relation), path = paths.get(binding.edge);
      if (!relation || !path || !path.classList.contains('LS-atlas_' + relation.from) || !path.classList.contains('LE-atlas_' + relation.to)) continue;
      path.dataset.relationId = relation.id;
      path.dataset.relationKind = relation.kind;
      if (relation.kind !== 'data_flow') continue;
      const length = path.getTotalLength();
      if (!Number.isFinite(length) || length <= 0) continue;
      const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('class', 'flow-particles');
      layer.setAttribute('aria-hidden', 'true');
      layer.setAttribute('pointer-events', 'none');
      layer.dataset.flowRelation = relation.id;
      if (path.hasAttribute('transform')) layer.setAttribute('transform', path.getAttribute('transform'));
      const particles = Array.from({ length: Math.min(3, Math.max(1, Math.ceil(length / 180))) }, () => {
        const particle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        particle.setAttribute('class', 'flow-particle');
        particle.setAttribute('r', '3.5');
        layer.appendChild(particle);
        return particle;
      });
      // Share the path's coordinate space and stay behind node and edge labels.
      path.after(layer);
      flowRoutes.push({ relation, path, length, layer, particles, active: true });
    }
    syncFlowSelection();
  }

  function relationCards(rows, heading) {
    rows = rows.filter(row => row.kind === 'data_flow');
    if (!rows.length) return '';
    return `<section class="relation-group"><h5>${esc(heading)} <span>${rows.length}</span></h5>${rows.map(row => `<article class="relation-card relation-data_flow" data-relation-id="${row.id}"><div class="relation-direction"><button class="text-link" data-focus-architecture="${row.from}">${esc(byId(row.from).name)}</button><span aria-hidden="true">→</span><button class="text-link" data-focus-architecture="${row.to}">${esc(byId(row.to).name)}</button>${freshnessBadge(row)}</div><strong>${esc(row.label)}</strong>${row.payload?.length ? `<div class="payload-list">${row.payload.map(value => `<span>${esc(value)}</span>`).join('')}</div>` : ''}<p class="relation-summary">${esc(row.summary)}</p>${row.sources?.length ? `<details><summary>查看源码依据</summary>${sourceReferences(row.sources)}</details>` : ''}</article>`).join('')}</section>`;
  }

  function renderArchitectureOverview(view) {
    selectedModule = null;
    selectedTable = null;
    $('reading-panel').dataset.kind = 'overview';
    $('reading-panel').dataset.subject = view.id;
    const rows = visibleRelations();
    readerMarkup('模块职责与数据流向', '架构导览', `<p class="reader-summary">先看各模块负责什么，再沿箭头了解传递的数据。点击模块可查看流入、流出与关联数据对象。</p><div class="architecture-stats"><span><b>${view.modules.length}</b> 个模块</span><span><b>${rows.length}</b> 条数据流</span></div>${rows.length ? '<div class="direction-guide"><p><span class="data-line"></span> 数据提供方 → 数据接收方</p><p>连线标注传递内容；处理先后与分支见业务流程。</p></div>' : '<p class="reader-empty">本视图尚未记录数据流向，可先查看模块职责。</p>'}<div class="module-entry-list">${view.modules.map(id => `<button data-focus-architecture="${id}">${icon(byId(id).icon)}<span>${esc(byId(id).name)}<small>${esc(byId(id).summary)}</small></span>${icon('arrow-up-right')}</button>`).join('')}</div>`, view.sources);
  }

  function dataObjectMarkup(table) {
    const fields = table.fields || [];
    return `<p class="reader-summary">${esc(table.description)}</p>${fields.length ? `<div class="field-table-wrap"><table class="field-table"><thead><tr><th>字段</th><th>类型</th><th>含义</th></tr></thead><tbody>${fields.map(field => `<tr><td><code>${esc(field.name)}</code>${field.key ? `<small class="field-key">${esc(field.key)}</small>` : ''}</td><td>${esc(field.type)}</td><td>${esc(field.description)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="reader-empty">字段结构尚未整理。</p>'}${fields.some(field => field.references) ? `<section class="relation-group"><h5>字段关联</h5>${fields.filter(field => field.references).map(field => `<div class="field-reference"><code>${esc(field.name)}</code><span>→</span><button class="text-link" data-focus-table="${esc(field.references.table)}">${esc(field.references.table)}.${esc(field.references.field)}</button><small>${field.references.kind === 'foreign_key' ? '数据库外键' : '逻辑关联 · 不代表数据库约束'}</small></div>`).join('')}</section>` : ''}${table.modules?.length ? `<div class="reader-relations"><span>关联模块</span>${table.modules.map(id => `<button class="text-link" data-focus-architecture="${id}">${esc(byId(id).name)}</button>`).join('')}</div>` : ''}`;
  }

  function renderDataOverview(view) {
    selectedModule = null; selectedStage = null; selectedTable = null;
    $('reading-panel').dataset.kind = 'view'; $('reading-panel').dataset.subject = view.id;
    readerMarkup('查看字段与关联', '数据结构', `<p class="reader-summary">${esc(view.subtitle || '点击图中的数据对象，查看字段、键和关联关系。')}</p><div class="module-entry-list">${(view.tables || []).map(name => { const table = byTable(name); return `<button data-focus-table="${esc(name)}">${icon('database')}<span>${esc(table.title)}<small>${table.fields?.length || 0} 个已登记字段</small></span>${icon('arrow-up-right')}</button>`; }).join('')}</div><p class="reader-empty">逻辑关联与数据库外键会分别标注，字段类型以本次整理的结构为准。</p>`, view.sources);
  }

  function inspectDataObject(name, { updateHash = true, reveal = false } = {}) {
    const table = byTable(name);
    if (!table) return;
    selectedModule = null; selectedStage = null; selectedTable = name;
    $('reading-panel').dataset.kind = 'table';
    $('reading-panel').dataset.subject = name;
    readerMarkup(table.title, table.kind, `${freshnessBadge(table)}${dataObjectMarkup(table)}`, table.sources);
    syncDiagramSelection();
    if (updateHash) updateReadingHash({ view: current.id, table: name });
    if (reveal) revealReader();
  }

  function focusArchitectureModule(id) {
    if (!byId(id)) return;
    if (!stage.querySelector(`[data-module="${id}"]`)) {
      const view = data.views.find(view => view.relationDiagrams && view.modules.includes(id)) || data.views.find(view => view.id !== 'catalog' && view.modules.includes(id));
      if (view && view.id !== current.id) navigate(view.id, false);
    }
    inspectModule(id, false, { readerOnly: true, reveal: true });
  }

  function focusDataObject(name) {
    const view = data.views.find(view => view.tables?.includes(name));
    if (view && view.id !== current.id) navigate(view.id, false);
    inspectDataObject(name, { reveal: true });
  }

  function revealReader() {
    if (compactLayout.matches) {
      showVisualPane('reader', true);
      return;
    }
    const panel = $('reading-panel');
    const box = panel.getBoundingClientRect();
    const headerBottom = document.querySelector('.app-header').getBoundingClientRect().bottom;
    if (box.top >= innerHeight || box.bottom <= headerBottom) {
      panel.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }

  function showVisualPane(pane = visualPane, reveal = false) {
    visualPane = pane;
    $('visual-layout').dataset.pane = pane;
    $('visual-tabs').hidden = !compactLayout.matches;
    $('diagram-tab').textContent = current?.diagram ? '查看图解' : '阶段导览';
    for (const name of ['diagram', 'reader']) {
      const tab = $(name === 'diagram' ? 'diagram-tab' : 'reader-tab');
      const panel = $(name === 'diagram' ? 'visual-main' : 'reading-panel');
      tab.setAttribute('aria-selected', String(name === pane));
      tab.tabIndex = name === pane ? 0 : -1;
      if (compactLayout.matches) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); }
      else { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
    }
    scheduleGraphLayout();
    syncFlowPlayback();
    if (reveal && compactLayout.matches) $('visual-workspace').scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  function syncDiagramSelection() {
    const connected = new Set();
    if (selectedModule) {
      for (const row of visibleRelations()) if (row.from === selectedModule || row.to === selectedModule) { connected.add(row.from); connected.add(row.to); }
      if (!current.relationDiagrams && !current.relations?.length) for (const row of [...authoredNeighbors(selectedModule, 'upstream'), ...authoredNeighbors(selectedModule, 'downstream')]) connected.add(row.id);
    }
    if (selectedTable) for (const table of data.tables) for (const field of table.fields || []) {
      if (field.references && (table.name === selectedTable || field.references.table === selectedTable)) { connected.add(table.name); connected.add(field.references.table); }
    }
    stage.querySelectorAll('[data-module], [data-graph-chain], [data-object]').forEach(node => {
      const exact = Boolean(selectedTable ? node.dataset.object === selectedTable : selectedStage ? node.dataset.graphChain === selectedStage.chain && node.dataset.graphStage === selectedStage.stage : selectedModule && node.dataset.module === selectedModule);
      node.classList.toggle('is-selected', exact);
      node.setAttribute('aria-pressed', String(exact));
      const item = selectedStage && data.chains.find(chain => chain.id === selectedStage.chain)?.stages.find(item => item.id === selectedStage.stage);
      const related = !exact && (connected.has(node.dataset.module || node.dataset.object) || item?.modules.includes(node.dataset.module));
      node.classList.toggle('is-related', Boolean(related));
      node.classList.toggle('is-muted', Boolean((selectedModule || selectedTable) && !exact && !related));
    });
    stage.querySelectorAll('path.flowchart-link').forEach(edge => {
      const id = (current.relationDiagrams ? 'atlas_' : '') + selectedModule;
      const touches = selectedModule && (edge.classList.contains('LS-' + id) || edge.classList.contains('LE-' + id));
      edge.classList.toggle('is-focused-edge', Boolean(touches));
      edge.classList.toggle('is-muted-edge', Boolean(selectedModule && !touches));
    });
    const normalizedLabel = value => String(value).replace(/\s+/g, ' ').trim();
    stage.querySelectorAll('g.edgeLabel').forEach(label => {
      const matches = current.relationDiagrams ? visibleRelations().filter(row => normalizedLabel(row.label) === normalizedLabel(label.textContent)) : [];
      label.classList.toggle('is-muted-label', Boolean(selectedModule && matches.length && matches.every(row => row.from !== selectedModule && row.to !== selectedModule)));
    });
    $('clear-focus').hidden = !selectedModule && !selectedTable;
    $('focus-caption').textContent = selectedModule ? `当前模块：${byId(selectedModule).name}` : selectedTable ? `当前对象：${byTable(selectedTable).title}` : current?.tables?.length ? '点击数据对象，查看字段与关联' : '点击模块，查看职责与数据流向';
    $('focus-caption').title = $('focus-caption').textContent;
    syncFlowSelection();
  }

  function renderModuleReader(module) {
    $('reading-panel').dataset.kind = 'module';
    $('reading-panel').dataset.subject = module.id;
    const incoming = dataFlows.filter(row => row.to === module.id);
    const outgoing = dataFlows.filter(row => row.from === module.id);
    const objects = data.tables.filter(table => table.modules?.includes(module.id));
    readerMarkup(module.name, module.category, `<div class="status-stack">${freshnessBadge(module)}</div><p class="reader-summary">${esc(module.summary)}</p>${relationCards(incoming, '流入：接收什么数据')}${relationCards(outgoing, '流出：向谁提供数据')}${!incoming.length && !outgoing.length ? '<p class="reader-empty">该模块的数据流向尚未记录。</p>' : ''}${objects.length ? `<section class="relation-group"><h5>关联数据对象</h5>${objects.map(table => `<button class="related-module" data-focus-table="${esc(table.name)}">${icon('database')}${esc(table.title)} ${icon('arrow-up-right')}</button>`).join('')}</section>` : ''}${module.facts.length ? `<details class="reader-facts"><summary>职责与边界</summary><ul>${module.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul></details>` : ''}`, module.sources);
  }

  function selectStage(chainId, stageId, { updateHash = true, reveal = false } = {}) {
    const chain = viewChains(current).find(item => item.id === chainId);
    const item = chain?.stages.find(item => item.id === stageId);
    if (!item) return;
    if (selectedStage?.chain !== chainId) renderSequenceDescription(current, chainId);
    selectedStage = { chain: chainId, stage: stageId };
    selectedModule = null;
    selectedTable = null;
    $('reading-panel').dataset.kind = 'stage';
    $('reading-panel').dataset.subject = `${chainId}/${stageId}`;
    document.querySelectorAll('[data-select-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.selectStage === chainId && button.dataset.stage === stageId)));
    const index = chain.stages.indexOf(item);
    const adjacent = offset => chain.stages[index + offset];
    const navButton = (offset, label) => `<button class="text-link" ${adjacent(offset) ? `data-select-stage="${chainId}" data-stage="${adjacent(offset).id}"` : 'disabled'}>${label}</button>`;
    readerMarkup(item.label, `${chain.title} · ${index + 1} / ${chain.stages.length}`, `<div class="status-stack">${statusBadge(item.status)}${freshnessBadge(item) || freshnessBadge(chain)}</div><p class="reader-summary">${esc(item.summary)}</p>${item.nextCheck ? `<p class="next-question"><strong>还需要确认</strong>${esc(item.nextCheck)}</p>` : ''}${item.modules.length ? `<div class="reader-relations"><span>参与模块</span>${item.modules.map(id => `<button class="text-link" data-focus-architecture="${id}">${esc(byId(id).name)}</button>`).join('')}</div>` : ''}${relationCards(data.relations.filter(row => item.relations?.includes(row.id)), '本环节的数据传递')}<div class="reader-stage-controls">${navButton(-1, '← 上一环节')}<button class="text-link stage-permalink" data-copy-stage="${chainId}" data-stage="${stageId}" aria-label="复制阶段链接">${icon('link')}</button>${navButton(1, '下一环节 →')}</div>`, item.sources);
    syncDiagramSelection();
    if (updateHash) updateReadingHash({ view: current.id, chain: chainId, stage: stageId });
    if (reveal) revealReader();
  }

  function renderVisualReader(view) {
    selectedStage = null;
    const chain = renderSequenceDescription(view);
    if (chain) selectStage(chain.id, chain.stages[0].id, { updateHash: false });
    else if (view.tables?.length) renderDataOverview(view);
    else if (view.modules.length) renderArchitectureOverview(view);
    else {
      $('reading-panel').dataset.kind = 'view';
      $('reading-panel').dataset.subject = view.id;
      readerMarkup(view.title, '读图提示', `<p class="reader-summary">${esc(view.subtitle)}</p>${view.notes.map(([title, text]) => `<div class="reader-explanation"><h5>${esc(title)}</h5><p>${esc(text)}</p></div>`).join('')}`, view.sources);
    }
  }

  function nav() {
    let group = '';
    $('view-nav').innerHTML = data.views.map(view => {
      const heading = group === view.group ? '' : `<div class="nav-group">${esc(view.group)}</div>`;
      group = view.group;
      return `${heading}<button class="view-link" data-view="${view.id}" aria-current="false">${icon(view.icon)}<span>${esc(view.title)}</span></button>`;
    }).join('');
    $('view-nav').addEventListener('click', event => {
      const button = event.target.closest('[data-view]');
      if (button) navigate(button.dataset.view);
    });
    $('sidebar-stats').textContent = `${data.stats.diagrams} 张图 / ${data.modules.length} 个模块 / ${data.stats.files} 个文件`;
  }

  function closeNav() {
    $('sidebar').classList.remove('is-open');
    $('nav-backdrop').hidden = true;
    $('open-nav').setAttribute('aria-expanded', 'false');
  }

  function navigate(id, updateHash = true, { preserveScroll = false } = {}) {
    clearFlowAnimation();
    const view = data.views.find(item => item.id === id) || data.views[0];
    current = view;
    selectedModule = null;
    selectedStage = null;
    selectedTable = null;
    if (!preserveScroll) visualPane = 'diagram';
    showVisualPane();
    if (!preserveScroll) window.scrollTo({ top: 0, behavior: 'instant' });
    if (updateHash && location.hash !== '#' + view.id) history.pushState(null, '', '#' + view.id);
    const overview = view.id === overviewId;
    $('overview-link').hidden = overview;
    $('project-intro').hidden = !overview;
    $('summary-strip').hidden = !overview;
    $('chain-section').hidden = !overview || !data.chains.length;
    $('quality-section').hidden = !overview || !data.quality?.warnings?.length;
    $('findings-section').hidden = !overview || !data.findings.length;
    closeNav();
    $('module-search').value = '';
    $('search-results').hidden = true;
    $('view-nav').hidden = false;
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-current', button.dataset.view === view.id ? 'page' : 'false'));
    $('view-group').textContent = overview ? '项目架构' : view.group;
    $('view-title').textContent = view.title;
    $('view-subtitle').textContent = view.freshness === 'stale' ? `${view.subtitle} · 待复核` : view.subtitle;
    $('view-tags').innerHTML = view.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
    $('show-view-evidence').hidden = !view.sources?.length;
    $('graph-explore').hidden = !view.relationDiagrams && !['overview', 'dependency', 'data_flow', 'data'].includes(view.kind);
    $('clear-focus').hidden = true;
    $('focus-caption').textContent = view.tables?.length ? '点击数据对象，查看字段与关联' : '点击模块，查看职责与数据流向';
    const legend = view.relationDiagrams ? [{ label: '数据流向：提供方 → 接收方', color: '#238577' }] : view.legend || (/^\s*(flowchart|graph)\s/.test(view.diagram || '') ? [
      { label: '入口', color: '#a8bfe4' }, { label: '业务', color: '#8ebba6' },
      { label: '处理 / 流程', color: '#ddbc7c' }, { label: '外部系统', color: '#d4a498' }
    ] : []);
    $('view-legend').innerHTML = legend.map(item => `<span><b class="swatch" style="background:${/^#[a-fA-F0-9]{6}$/.test(item.color) ? item.color : '#89958c'}"></b>${esc(item.label)}</span>`).join('');
    $('view-notes').innerHTML = view.notes.map(([title, text]) => `<article class="fact-item"><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`).join('');
    $('view-notes').hidden = !view.notes.length;
    (view.id === 'catalog' ? $('catalog-section') : $('visual-layout')).appendChild($('view-notes'));
    $('module-detail').hidden = true;
    $('module-section').hidden = view.id === 'catalog' || !view.modules.length;
    $('module-list').innerHTML = view.modules.map(id => {
      const module = byId(id);
      const downstream = [...new Set(dataFlows.filter(row => row.from === id).map(row => row.to))].map(id => byId(id));
      return `<tr><td><button class="module-row" data-focus-architecture="${id}">${icon(module.icon)}<span><strong>${esc(module.name)}</strong><small>${esc(module.category)}</small></span></button></td><td>${esc(module.summary)}</td><td>${downstream.length ? downstream.map(item => `<button class="text-link" data-focus-architecture="${item.id}">${esc(item.name)}</button>`).join('<br>') : '<span class="table-empty">尚未记录</span>'}</td><td>${sourceReferences(module.sources.slice(0, 1))}</td></tr>`;
    }).join('');
    $('module-count').textContent = `${view.modules.length} 项`;
    const responsibilityLabels = [...$('module-section').querySelectorAll('th')].map(cell => cell.textContent);
    $('module-list').querySelectorAll('tr').forEach(row => {
      [...row.cells].forEach((cell, index) => { cell.dataset.label = responsibilityLabels[index]; });
    });
    $('alias-section').hidden = !view.aliases;
    $('alias-list').innerHTML = Object.entries(view.aliases || {}).map(([name, table]) => `<div class="alias-row"><strong>${esc(name)}</strong><code>${esc(table)}</code></div>`).join('');
    const flowReading = ['模块之间的数据流向', '沿箭头查看数据从哪里来、传给谁；点击模块了解职责与输入输出。'];
    const graphReading = view.relationDiagrams ? flowReading : {
      data: ['数据结构与对象关联', '点击数据对象，查看字段含义、关联键及读写它的模块。'],
      data_flow: flowReading,
      dependency: ['模块协作与职责边界', '按图中标注了解模块的协作方式，点击模块查看职责说明。'],
      state: ['业务状态与变化条件', '查看当前状态、触发动作及变化后的结果。'],
      recovery: ['遇到异常后如何恢复', '沿着分支了解失败后的处理、重试与恢复过程。'],
      sequence: ['参与方之间的处理顺序', '沿时间方向查看请求与返回；点击阶段了解参与方、处理条件和结果。'],
      flow: ['业务处理流程', '从触发条件走到处理结果；沿分支查看继续、中止与失败的条件。'],
      narrative: ['业务流程导览', '选择一个环节，查看它的业务含义、参与模块与数据传递。']
    }[view.kind] || ['项目组成与模块职责', '先看模块分工与边界，再进入业务流程和数据流向。'];
    $('graph-reading-title').textContent = graphReading[0];
    $('graph-reading-lead').textContent = graphReading[1];
    $('visual-section').hidden = view.id === 'catalog';
    $('visual-section').classList.toggle('is-overview', view.kind === 'overview' || view.id === 'overview');
    $('graph-section').hidden = !view.diagram;
    $('catalog-section').hidden = view.id !== 'catalog';
    if (view.id === 'catalog') {
      renderSerial++;
      viewport.dataset.renderState = 'ready';
      stage.replaceChildren();
      camera = { x: 0, y: 0, scale: 1 };
      renderCatalog();
      const moduleIndex = document.createElement('div');
      moduleIndex.className = 'module-list';
      moduleIndex.innerHTML = data.modules.map(module => `<button class="module-row" data-inspect-module="${module.id}">${icon(module.icon)}<span>${esc(module.name)}</span><small>${esc(module.category)}</small></button>`).join('');
      $('view-notes').appendChild(moduleIndex);
      $('view-notes').hidden = false;
      icons();
      return Promise.resolve();
    }
    renderVisualReader(view);
    if (!view.diagram) {
      renderSerial++;
      viewport.dataset.renderState = 'ready';
      $('graph-status').hidden = true;
      stage.replaceChildren();
      camera = { x: 0, y: 0, scale: 1 };
      icons();
      return Promise.resolve();
    }
    $('diagram-kind').textContent = view.relationDiagrams || view.kind === 'data_flow' ? '数据流向 / 连线标注传递内容' : view.diagram.trimStart().startsWith('sequenceDiagram') ? '交互时序 / 按消息顺序阅读' : view.diagram.trimStart().startsWith('erDiagram') ? '数据结构 / 字段与对象关联' : view.diagram.trimStart().startsWith('stateDiagram') ? '状态与触发条件' : view.diagram.trimStart().startsWith('mindmap') ? '模块职责树' : '处理流程 / 按连线与分支条件阅读';
    const visibleDiagrams = data.views.filter(item => item.diagram);
    $('diagram-counter').textContent = `${String(visibleDiagrams.indexOf(view) + 1).padStart(2, '0')} / ${data.stats.diagrams}`;
    $('canvas-stamp').textContent = `关系示意 · ${data.date}`;
    icons();
    const serial = ++renderSerial;
    const variant = view.relationDiagrams?.data_flow;
    const desktopDiagram = variant?.diagram || view.diagram;
    const mobileDiagram = variant?.mobileDiagram || view.mobileDiagram;
    const diagram = smallScreen.matches && mobileDiagram ? mobileDiagram : desktopDiagram;
    renderedDiagram = diagram;
    const cacheKey = `${view.id}::${diagram === mobileDiagram ? 'mobile' : 'desktop'}`;
    const renderId = `diagram_${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}_${serial}`;
    $('graph-status').hidden = false;
    $('graph-status').textContent = '正在绘制关系图';
    viewport.dataset.renderState = 'loading';
    $('export-svg').disabled = true;
    stage.replaceChildren();
    camera = { x: 0, y: 0, scale: 1 };
    paint();
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      if (serial !== renderSerial) return;
      try {
        let svg = cache.get(cacheKey);
        if (!svg) {
          svg = (await mermaid.render(renderId, diagram)).svg;
          cache.set(cacheKey, svg);
        }
        if (serial !== renderSerial) return;
        stage.innerHTML = svg;
        const element = stage.querySelector('svg');
        if (!element) throw new Error('EMPTY_DIAGRAM');
        const box = element.viewBox?.baseVal;
        const viewBox = element.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number) || [];
        const width = box?.width || viewBox[2] || Number.parseFloat(element.getAttribute('width')) || 0;
        const height = box?.height || viewBox[3] || Number.parseFloat(element.getAttribute('height')) || 0;
        diagramSize = { width, height };
        if (!(diagramSize.width > 0 && diagramSize.height > 0)) throw new Error('EMPTY_DIAGRAM');
        renderedDiagram = diagram;
        element.style.width = diagramSize.width + 'px';
        element.style.height = diagramSize.height + 'px';
        element.setAttribute('width', diagramSize.width);
        element.setAttribute('height', diagramSize.height);
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', view.title);
        element.querySelectorAll('g.node, g[id^="entity-"]').forEach(node => {
          const nodeId = node.id.match(/^flowchart-(.+)-\d+$/)?.[1] || node.querySelector('.entityLabel')?.textContent.trim();
          const moduleId = view.relationDiagrams && nodeId?.startsWith('atlas_') ? nodeId.slice(6) : nodeId;
          const tableName = Object.hasOwn(view.aliases || {}, nodeId) ? view.aliases[nodeId] : nodeId;
          const table = (view.kind === 'data' || view.tables?.includes(tableName)) && byTable(tableName);
          const binding = view.bindings?.find(binding => binding.node === nodeId);
          if (nodeId) node.dataset.diagramNode = nodeId;
          if (table || binding || (moduleId && byId(moduleId))) {
            node.setAttribute('tabindex', '0');
            node.setAttribute('role', 'button');
            if (table) {
              node.dataset.object = table.name;
              node.classList.add('data-object-node');
              node.setAttribute('aria-label', table.title + '，查看字段与关联');
            } else if (binding) {
              node.dataset.graphChain = binding.chain;
              node.dataset.graphStage = binding.stage;
              const item = data.chains.find(chain => chain.id === binding.chain)?.stages.find(item => item.id === binding.stage);
              node.setAttribute('aria-label', (item?.label || nodeId) + '，查看流程说明');
            } else {
              node.dataset.module = moduleId;
              node.setAttribute('aria-label', byId(moduleId).name + '，查看依赖与数据流');
            }
          }
        });
        if (element.querySelector('[role="button"]')) element.setAttribute('role', 'group');
        syncDiagramSelection();
        fitMode = true;
        layoutGraph();
        $('graph-status').hidden = true;
        $('export-svg').disabled = false;
        viewport.dataset.renderState = 'ready';
        viewport.dataset.view = view.id;
        prepareFlowAnimation(element, variant);
      } catch (error) {
        if (serial !== renderSerial) return;
        clearFlowAnimation();
        stage.replaceChildren();
        stage.innerHTML = `<div class="diagram-fallback"><strong>关系图暂时无法渲染</strong><p>模块关系、流程说明和追溯链接仍可查看。</p><details><summary>查看图形定义以排查问题</summary><pre>${esc(diagram)}</pre></details></div>`;
        $('graph-status').hidden = true;
        viewport.dataset.renderState = 'error';
        console.error('Diagram rendering failed:', view.id, error);
      }
    });
    return renderQueue;
  }

  function paint() {
    stage.style.transform = `translate(${camera.x}px,${camera.y}px) scale(${camera.scale})`;
    $('zoom-input').value = Math.round(camera.scale * 100);
  }

  function layoutGraph() {
    if (!current?.diagram || !viewport.clientWidth || !stage.querySelector('svg')) return;
    if (document.fullscreenElement !== $('graph-section')) {
      const padding = smallScreen.matches ? 24 : 44;
      const scale = Math.min(diagramSize.height > 420 ? 1 : 1.35, Math.max(.05, (viewport.clientWidth - padding) / diagramSize.width));
      const maximum = smallScreen.matches ? Math.max(480, Math.min(1100, innerHeight * 1.3)) : Math.max(420, Math.min(1000, innerHeight * 1.25));
      const height = Math.ceil(Math.max(smallScreen.matches ? 200 : 180, Math.min(maximum, diagramSize.height * scale + padding)));
      if (viewport.style.getPropertyValue('--diagram-height') !== height + 'px') viewport.style.setProperty('--diagram-height', height + 'px');
    }
    if (fitMode) fit();
  }

  let layoutFrame = null;
  function scheduleGraphLayout() {
    if (layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => { layoutFrame = null; layoutGraph(); });
  }

  function fit() {
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    fitMode = true;
    const padding = smallScreen.matches ? 24 : 44;
    camera.scale = Math.max(0.05, Math.min((viewport.clientWidth - padding) / diagramSize.width, (viewport.clientHeight - padding) / diagramSize.height, 1.5));
    camera.x = (viewport.clientWidth - diagramSize.width * camera.scale) / 2;
    camera.y = (viewport.clientHeight - diagramSize.height * camera.scale) / 2;
    paint();
  }

  function zoom(scale, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
    scale = Math.max(0.05, Math.min(4, scale));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    fitMode = false;
    paint();
  }

  const pointers = new Map();
  let previousPinch;
  let dragOrigin;
  let pointerModule = null;
  let pointerStage = null;
  let pointerObject = null;
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    moved = false;
    pointerModule = event.target.closest('[data-module]')?.dataset.module || null;
    const bound = event.target.closest('[data-graph-chain]');
    pointerStage = bound ? { chain: bound.dataset.graphChain, stage: bound.dataset.graphStage } : null;
    pointerObject = event.target.closest('[data-object]')?.dataset.object || null;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragOrigin = { x: event.clientX, y: event.clientY };
    viewport.setPointerCapture(event.pointerId);
    previousPinch = null;
  });
  viewport.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    const last = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const rect = viewport.getBoundingClientRect();
      if (previousPinch && distance > 0) zoom(camera.scale * distance / previousPinch, (first.x + second.x) / 2 - rect.left, (first.y + second.y) / 2 - rect.top);
      previousPinch = distance;
      moved = true;
    } else if (dragOrigin && (moved || Math.hypot(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y) > 4)) {
      moved = true;
      camera.x += event.clientX - last.x;
      camera.y += event.clientY - last.y;
      fitMode = false;
      paint();
    }
    if (moved) viewport.classList.add('is-dragging');
  });
  function finishPointer(event) {
    const clickedModule = event.type === 'pointerup' && pointers.size === 1 && !moved ? pointerModule : null;
    const clickedStage = event.type === 'pointerup' && pointers.size === 1 && !moved ? pointerStage : null;
    const clickedObject = event.type === 'pointerup' && pointers.size === 1 && !moved ? pointerObject : null;
    pointers.delete(event.pointerId);
    previousPinch = null;
    if (!pointers.size) viewport.classList.remove('is-dragging');
    pointerModule = null;
    pointerStage = null;
    pointerObject = null;
    if (clickedObject) inspectDataObject(clickedObject, { reveal: true });
    else if (clickedStage) selectStage(clickedStage.chain, clickedStage.stage, { reveal: true });
    else if (clickedModule) inspectModule(clickedModule, false, { readerOnly: true, reveal: true });
  }
  viewport.addEventListener('pointerup', finishPointer);
  viewport.addEventListener('pointercancel', finishPointer);
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoom(camera.scale * Math.exp(-event.deltaY * .008), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.target.matches('[data-object]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); inspectDataObject(event.target.dataset.object, { reveal: true }); return;
    }
    if (event.target.matches('[data-graph-chain]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      selectStage(event.target.dataset.graphChain, event.target.dataset.graphStage, { reveal: true });
      return;
    }
    if (event.target.matches('[data-module]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      inspectModule(event.target.dataset.module, false, { readerOnly: true, reveal: true });
      return;
    }
    const offsets = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] };
    if (offsets[event.key]) {
      event.preventDefault();
      const [x, y] = offsets[event.key];
      camera.x += x; camera.y += y; fitMode = false; paint();
    }
  });

  function sourceListMarkup(sources) {
    return sources.map((source, index) => `<button class="evidence-link" data-direct-source="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('');
  }

  function modulePassportMarkup(module, focusReach) {
    const upstream = authoredNeighbors(module.id, 'upstream');
    const downstream = authoredNeighbors(module.id, 'downstream');
    const upstreamTitle = dataFlows.length ? '数据从哪里来' : '已记录的上游模块';
    const downstreamTitle = dataFlows.length ? '数据传给谁' : '已记录的下游模块';
    const list = (items, direction) => items.length
      ? `<div class="passport-links">${items.map(item => `<button class="passport-link" data-focus-module="${item.id}" data-focus-reach="${direction}">${icon(direction === 'upstream' ? 'arrow-up-left' : 'arrow-down-right')}<span>${esc(item.name)}</span></button>`).join('')}</div>`
      : '<p class="passport-empty">尚未记录</p>';
    const routePairs = upstream.flatMap(source => downstream.filter(target => target.id !== source.id).map(target => [source, target])).slice(0, 8);
    return `<section class="module-passport" aria-label="${esc(module.name)} 的协作关系">
      <div class="passport-heading"><div><div class="detail-heading">${dataFlows.length ? '数据来源与去向' : '已记录的模块协作'}</div><p>${dataFlows.length ? '沿已记录的数据流查看相邻模块，具体处理顺序见业务流程。' : '协作关系尚未补充数据内容，可先查看相邻模块的职责。'}</p></div><button class="text-link module-copy-link" data-copy-focus="${module.id}" data-focus-reach="${esc(focusReach || '')}">${icon('link')}分享当前模块</button></div>
      <div class="passport-stats"><span><strong>${upstream.length}</strong> ${upstreamTitle}</span><span><strong>${downstream.length}</strong> ${downstreamTitle}</span></div>
      <div class="passport-columns"><div><h4>${upstreamTitle}</h4>${list(upstream, 'upstream')}</div><div><h4>${downstreamTitle}</h4>${list(downstream, 'downstream')}</div></div>
      ${routePairs.length ? `<div class="passport-routes"><h4>${dataFlows.length ? '沿数据流继续查看' : '继续查看协作路径'}</h4><div class="passport-links">${routePairs.map(([source, target]) => `<button class="passport-link passport-route-link" data-authored-route="${esc(source.id + '~' + target.id)}">${icon('route')}<span>${esc(source.name)} → ${esc(target.name)}</span></button>`).join('')}</div></div>` : ''}
    </section>`;
  }

  function moduleMarkup(module, options = {}) {
    return `<div class="module-detail-heading"><h3>${esc(module.name)}</h3><span class="status-stack">${freshnessBadge(module)}</span></div>
      <p class="summary">${esc(module.summary)}</p>
      ${module.staleReason ? `<p class="stale-note">${esc(module.staleReason)}</p>` : ''}
      ${module.facts.length ? `<h4>你需要了解的事</h4><ul>${module.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul>` : ''}
      ${modulePassportMarkup(module, options.focusReach)}
      <details class="technical-evidence" data-technical-evidence><summary>查看源码依据 · ${module.sources.length} 处</summary>
      <p>需要核对实现时，从下面的文件位置继续查看。</p>
      ${module.sources.map((source, index) => `<button class="evidence-link" data-evidence-module="${module.id}" data-source="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">${sourceLocation(source)} · ${esc(source.path)}</span></span></button>`).join('')}</details>`;
  }

  function showSourceCollection(title, description, sources) {
    showDialog(title, `<p>${esc(description || '')}</p><div class="detail-heading">源码依据 · ${sources.length} 处</div>${sourceListMarkup(sources)}`, sources);
  }

  function findingMarkup(finding) {
    const related = finding.modules.map(id => byId(id)).filter(Boolean);
    return `<div class="detail-status">${statusBadge(finding.kind, kindLabels[finding.kind])}${statusBadge(finding.status)}${freshnessBadge(finding)}</div>
      <p>${esc(finding.summary)}</p>
      ${finding.staleReason ? `<p class="stale-note">${esc(finding.staleReason)}</p>` : ''}
      ${finding.impact ? `<h4>这意味着什么</h4><p>${esc(finding.impact)}</p>` : ''}
      ${finding.nextCheck ? `<h4>接下来确认什么</h4><p>${esc(finding.nextCheck)}</p>` : ''}
      ${related.length ? `<h4>关联模块</h4><div class="related-links">${related.map(module => `<button class="text-link" data-inspect-module="${module.id}">${esc(module.name)}</button>`).join('')}</div>` : ''}
      <h4>源码依据 · ${finding.sources.length} 处</h4>${finding.sources.map((source, index) => `<button class="evidence-link" data-finding-source="${finding.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}`;
  }

  function showFinding(id) {
    const finding = data.findings.find(item => item.id === id);
    if (finding) showDialog(finding.title, findingMarkup(finding));
  }

  function showCoverage(id) {
    const item = data.coverage.find(entry => entry.id === id);
    if (!item) return;
    const related = item.modules.map(moduleId => byId(moduleId)).filter(Boolean);
     showDialog(item.area, `<div class="detail-status">${statusBadge(item.status)}${freshnessBadge(item)}</div><p>${esc(item.summary)}</p>
      ${item.nextCheck ? `<h4>后续确认</h4><p>${esc(item.nextCheck)}</p>` : ''}
      ${related.length ? `<h4>关联模块</h4><div class="related-links">${related.map(module => `<button class="text-link" data-inspect-module="${module.id}">${esc(module.name)}</button>`).join('')}</div>` : ''}
      ${item.sources.length ? `<h4>源码依据 · ${item.sources.length} 处</h4>${item.sources.map((source, index) => `<button class="evidence-link" data-coverage-source="${item.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}` : ''}`);
  }

  function chainProgress(chain) {
    const applicable = chain.stages.filter(stage => stage.status !== 'not_applicable');
    const total = applicable.length;
    const covered = applicable.filter(stage => stage.status === 'covered').length;
    const partial = applicable.filter(stage => stage.status === 'partial').length;
    const unknown = applicable.filter(stage => stage.status === 'unknown').length;
    const status = !total ? 'not_applicable' : covered === total ? 'covered' : covered || partial ? 'partial' : 'unknown';
    return { total, covered, partial, unknown, notApplicable: chain.stages.length - total, status, review: needsReview(chain) || chain.stages.some(needsReview), percent: total ? Math.round(covered / total * 100) : 0 };
  }

  function chainProgressLabel(chain) {
    const progress = chainProgress(chain);
    return [progress.total ? `${progress.covered}/${progress.total} 个适用阶段已覆盖` : '无适用阶段', progress.partial ? `${progress.partial} 个部分覆盖` : '', progress.unknown ? `${progress.unknown} 个待确认` : '', progress.notApplicable ? `${progress.notApplicable} 个不适用` : ''].filter(Boolean).join(' · ');
  }

  function chainBadges(chain) {
    const progress = chainProgress(chain);
    return statusBadge(progress.status) + (progress.review ? statusBadge('stale', '待复核') : '');
  }

  function chainMarkup(chain) {
    const views = chain.views.map(id => data.views.find(view => view.id === id)).filter(Boolean);
    return `<div class="detail-status">${statusBadge(chain.kind, chainKindLabel(chain))}${chainBadges(chain)}</div><p class="chain-coverage-summary">${esc(chainProgressLabel(chain))}</p>
      <p>${esc(chain.summary)}</p><div class="chain-route"><strong>从哪里开始</strong><span>${esc(chain.trigger)}</span><b>→</b><strong>最后得到什么</strong><span>${esc(chain.outcome)}</span></div>
      <h4>逐步了解处理过程</h4><div class="chain-stage-list">${chain.stages.map(stage => `<div class="chain-stage"><div><strong>${esc(stage.label)}</strong>${statusBadge(stage.status)}${freshnessBadge(stage)}<button class="text-link stage-permalink" data-copy-stage="${chain.id}" data-stage="${stage.id}" aria-label="复制阶段链接">${icon('link')}</button></div><p>${esc(stage.summary)}</p>${stage.nextCheck ? `<small class="next-question"><strong>还需要确认</strong>${esc(stage.nextCheck)}</small>` : ''}${stage.sources?.length ? `<div class="chain-stage-sources">${stage.sources.map((source, index) => `<button class="evidence-link" data-chain-stage-source="${chain.id}" data-stage="${stage.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}</div>` : ''}</div>`).join('')}</div>
      ${views.length ? `<h4>关联视图</h4><div class="related-links">${views.map(view => `<button class="text-link" data-chain-view="${view.id}">${icon(view.icon)}${esc(view.title)}</button>`).join('')}</div>` : ''}
      <h4>链路源码依据 · ${chain.sources.length} 处</h4>${chain.sources.map((source, index) => `<button class="evidence-link" data-chain-source="${chain.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}`;
  }

  function showChain(id) {
    const chain = data.chains.find(item => item.id === id);
    if (chain) showDialog(chain.title, chainMarkup(chain), null, { view: chain.readingView || current.id, chain: chain.id });
  }

  function authoredRouteMarkup(sourceId, targetId, path) {
    const source = byId(sourceId);
    const target = byId(targetId);
    return `<div class="detail-status"><span class="tag">协作路径</span><span class="tag">连接 ${path.length} 个环节</span></div>
      <p>从「${esc(source.name)}」到「${esc(target.name)}」，本报告记录了下面这些联系。每个环节都可以继续展开查看。</p>
      <ol class="authored-route">${path.map((id, index) => { const module = byId(id); return `<li><span class="route-index">${index + 1}</span><button class="text-link strong-link" data-focus-module="${module.id}">${esc(module.name)}</button><small>${esc(module.summary)}</small>${index < path.length - 1 ? '<span class="route-arrow" aria-hidden="true">→</span>' : ''}</li>`; }).join('')}</ol>
      <p class="passport-disclaimer">这里展示已梳理的联系；实际执行先后与异常处理，请结合相应业务流程阅读。</p>`;
  }

  function showAuthoredRoute(value, updateHash = true) {
    const pair = routePair(value);
    const path = pair ? authoredRoute(pair[0], pair[1]) : null;
    if (!pair || !path) { showToast('报告中尚未记录这两个环节之间的联系'); return; }
    const route = { view: current?.id || overviewId, route: pair.join('~') };
    if (updateHash) updateReadingHash(route);
    showDialog(`${byId(pair[0]).name} → ${byId(pair[1]).name}`, authoredRouteMarkup(pair[0], pair[1], path), null, route);
  }

  function restoreLocation() {
    if (dialog.open) dialog.close();
    dialogHistory.length = 0;
    const hash = location.hash.slice(1);
    const route = hash.includes('=') ? Object.fromEntries(new URLSearchParams(hash)) : { view: hash || overviewId };
    const chain = route.chain ? data.chains.find(row => row.id === route.chain) : null;
    const stage = route.stage ? chain?.stages.find(row => row.id === route.stage) : null;
    const target = route.evidence ? evidenceTargets.get(route.evidence) : null;
    const focus = route.focus ? byId(route.focus) : null;
    const table = route.table ? byTable(route.table) : null;
    const focusReach = ['upstream', 'downstream'].includes(route.reach) ? route.reach : null;
    const routePairValue = route.route;
    const authoredPair = routePairValue ? routePair(routePairValue) : null;
    const authoredPath = authoredPair ? authoredRoute(authoredPair[0], authoredPair[1]) : null;
    navigate(route.view || chain?.readingView || target?.view || overviewId, false, { mode: route.mode });
    if ((route.table && !table) || (route.mode && !(current.relationDiagrams && ['dependency', 'all', 'data_flow'].includes(route.mode))) || (route.chain && !chain) || (route.stage && !stage) || (route.evidence && !target) || (route.focus && !focus) || (route.reach && !focusReach) || (route.route && (!authoredPair || !authoredPath)) || (target && route.chain && target.chain !== route.chain) || (target && route.stage && target.stage !== route.stage) || (route.view && !data.views.some(view => view.id === route.view))) {
      showToast('定位目标不存在，已显示可用视图。'); return;
    }
    if (stage) {
      selectStage(chain.id, stage.id, { updateHash: false });
      if (compactLayout.matches) showVisualPane('reader');
      const element = [...document.querySelectorAll('[data-stage-anchor]')].find(element => element.dataset.stageAnchor === chain.id + '/' + stage.id);
      if (element) { element.classList.add('is-target'); element.tabIndex = -1; element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); }
    }
    if (chain && !stage) showChain(chain.id);
    if (target) {
      if (chain && !dialog.open) showChain(chain.id);
      showEvidence(target.source, target.title);
    }
    if (focus) inspectModule(focus.id, current.id === 'catalog', { focusReach, updateHash: false, readerOnly: true });
    if (table) { inspectDataObject(table.name, { updateHash: false }); if (compactLayout.matches) showVisualPane('reader'); }
    if (authoredPair) showAuthoredRoute(routePairValue, false);
  }

  function renderChains() {
    const section = $('chain-section');
    section.hidden = current?.id !== overviewId || !data.chains.length;
    const chains = data.chains.filter(chain => {
      const progress = chainProgress(chain);
      if (chainFilter === 'review') return progress.review;
      if (chainFilter === 'incomplete') return progress.covered < progress.total;
      if (chainFilter === 'covered') return progress.status === 'covered';
      return true;
    });
    $('chain-count').textContent = `${chains.length} / ${data.chains.length} 条链路`;
    chainPage = Math.min(chainPage, Math.max(0, Math.ceil(chains.length / chainPageSize) - 1));
    renderPager('chain-pages', chainPage, chains.length, chainPageSize, 'chains');
    $('chain-grid').innerHTML = chains.length ? chains.slice(chainPage * chainPageSize, (chainPage + 1) * chainPageSize).map(chain => {
      const progress = chainProgress(chain);
      return `<article class="chain-card"><div class="chain-card-head"><div><span class="eyebrow">${esc(chainKindLabel(chain))}</span><h4><button class="chain-title-link" data-chain-reading="${chain.id}">${esc(chain.title)}</button></h4></div><div class="status-stack">${chainBadges(chain)}</div></div><p>${esc(chain.summary)}</p><div class="chain-endpoints"><span><strong>从哪里开始</strong>${esc(chain.trigger)}</span><span><strong>最后得到什么</strong>${esc(chain.outcome)}</span></div><div class="chain-progress" aria-hidden="true"><span style="width:${progress.percent}%"></span></div><p class="chain-coverage-summary">${esc(chainProgressLabel(chain))}</p><div class="chain-meta"><button class="text-link" data-chain-reading="${chain.id}">阅读流程 ${icon('arrow-right')}</button><button class="text-link" data-chain="${chain.id}">查看证据</button></div></article>`;
    }).join('') : '<div class="empty-state">当前筛选条件下没有业务链路。</div>';
    icons();
  }

  function renderQuality() {
    const warnings = data.quality?.warnings || [];
    $('quality-section').hidden = current?.id !== overviewId || !warnings.length;
    $('quality-count').textContent = `${warnings.length} 项`;
    $('quality-list').innerHTML = warnings.map(warning => `<li>${esc(warning)}</li>`).join('');
  }

  function renderHighlights() {
    const rank = { risk: 0, gap: 1, decision: 2, fact: 3 };
    const findings = [...data.findings].sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 3);
    $('finding-highlights').innerHTML = findings.map(finding => `<article class="finding-highlight"><div class="status-stack">${statusBadge(finding.kind, kindLabels[finding.kind])}${statusBadge(finding.status)}${freshnessBadge(finding)}</div><h4><button class="text-link strong-link" data-finding="${finding.id}">${esc(finding.title)}</button></h4><p>${esc(finding.summary)}</p>${finding.impact ? `<p class="finding-impact"><strong>这意味着什么</strong>${esc(finding.impact)}</p>` : ''}${finding.nextCheck ? `<p class="next-question"><strong>还需要确认</strong>${esc(finding.nextCheck)}</p>` : ''}</article>`).join('');
  }

  function inspectModule(id, modal = false, options = {}) {
    const module = byId(id);
    if (!module) return;
    const route = { view: current?.id || overviewId, focus: module.id, reach: options.focusReach };
    if (modal || current.id === 'catalog' || dialog.open) {
      showDialog(module.name, moduleMarkup(module, options), null, route);
      return;
    }
    selectedModule = id;
    selectedStage = null;
    selectedTable = null;
    syncDiagramSelection();
    if (current.id !== 'catalog') renderModuleReader(module);
    if (options.updateHash !== false) updateReadingHash(route);
    if (options.readerOnly && current.id !== 'catalog' && !dialog.open) {
      if (options.reveal) revealReader();
    } else {
      $('module-detail').innerHTML = moduleMarkup(module, options);
      $('module-detail').hidden = false;
      $('module-list').querySelectorAll('[data-module]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.module === id)));
      icons();
      $('module-detail').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  document.addEventListener('click', event => {
    const reference = event.target.closest('[data-evidence-key]');
    if (reference && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault(); const target = evidenceTargets.get(reference.dataset.evidenceKey); if (target) showEvidence(target.source, target.title); return;
    }
    const architectureModule = event.target.closest('[data-focus-architecture]');
    if (architectureModule) { focusArchitectureModule(architectureModule.dataset.focusArchitecture); return; }
    const object = event.target.closest('[data-focus-table]');
    if (object) { focusDataObject(object.dataset.focusTable); return; }
    const pane = event.target.closest('[data-visual-pane]');
    if (pane) { showVisualPane(pane.dataset.visualPane, true); return; }
    const step = event.target.closest('[data-select-stage]');
    if (step) { selectStage(step.dataset.selectStage, step.dataset.stage, { reveal: true }); return; }
    const readerModule = event.target.closest('[data-reader-module]');
    if (readerModule) { inspectModule(readerModule.dataset.readerModule, false, { readerOnly: true, reveal: true }); return; }
    const copyFocus = event.target.closest('[data-copy-focus]');
    if (copyFocus) {
      copyLink({ view: current?.id || overviewId, focus: copyFocus.dataset.copyFocus, reach: copyFocus.dataset.focusReach || undefined });
      return;
    }
    const authored = event.target.closest('[data-authored-route]');
    if (authored) { showAuthoredRoute(authored.dataset.authoredRoute); return; }
    const focus = event.target.closest('[data-focus-module]');
    if (focus) {
      inspectModule(focus.dataset.focusModule, dialog.open || current?.id === 'catalog', { focusReach: focus.dataset.focusReach, updateHash: true });
      return;
    }
    const evidence = event.target.closest('[data-evidence-module]');
    if (evidence) { showEvidence(byId(evidence.dataset.evidenceModule).sources[Number(evidence.dataset.source)]); return; }
    const inspect = event.target.closest('[data-inspect-module]');
    if (inspect) { inspectModule(inspect.dataset.inspectModule, true); return; }
    const module = event.target.closest('[data-module]');
    if (module && !stage.contains(module)) inspectModule(module.dataset.module);
    const directSource = event.target.closest('[data-direct-source]');
    if (directSource) showEvidence(dialog._directSources[Number(directSource.dataset.directSource)]);
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'reader-chain') {
      const chain = viewChains(current).find(chain => chain.id === event.target.value);
      if (chain) selectStage(chain.id, chain.stages[0].id);
    }
  });

  $('visual-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const pane = event.key === 'Home' ? 'diagram' : event.key === 'End' ? 'reader' : visualPane === 'diagram' ? 'reader' : 'diagram';
    showVisualPane(pane, true);
    $(pane === 'diagram' ? 'diagram-tab' : 'reader-tab').focus({ preventScroll: true });
  });

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function exportSvg() {
    const original = stage.querySelector('svg');
    if (!original) return;
    const svg = original.cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', Math.ceil(diagramSize.width));
    svg.setAttribute('height', Math.ceil(diagramSize.height));
    svg.style.width = ''; svg.style.height = ''; svg.style.backgroundColor = '#fff';
    svg.querySelectorAll('.flow-particles').forEach(layer => layer.remove());
    svg.querySelectorAll('[tabindex]').forEach(node => node.removeAttribute('tabindex'));
    for (const name of ['is-selected', 'is-related', 'is-muted', 'is-focused-edge', 'is-muted-edge', 'is-muted-label']) {
      svg.querySelectorAll('.' + name).forEach(node => node.classList.remove(name));
    }
    download(`${current.title}.svg`, '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg), 'image/svg+xml;charset=utf-8');
    showToast('SVG 已导出');
  }

  function showMermaidSource() {
    sourceForCopy = renderedDiagram || current.diagram || '';
    showDialog('Mermaid 源码 · ' + current.title, `<pre>${esc(sourceForCopy)}</pre><div class="dialog-actions"><button class="command-button" id="copy-mermaid">${icon('copy')}复制源码</button><button class="command-button" id="download-mermaid">${icon('download')}导出 .mmd</button></div>`);
  }

  async function copySource() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(sourceForCopy);
      else {
        const input = document.createElement('textarea');
        input.value = sourceForCopy; $('dialog-body').appendChild(input); input.select();
        const ok = document.execCommand('copy'); input.remove();
        if (!ok) throw new Error('COPY_UNAVAILABLE');
      }
      showToast('源码已复制');
    } catch { showToast('剪贴板不可用，可导出 .mmd 文件'); }
  }

  function renderCatalog() {
    const query = $('catalog-search').value.toLowerCase().trim();
    const rows = data[catalogMode].filter(row => matchesSearch(row, query));
    catalogPage = Math.min(catalogPage, Math.max(0, Math.ceil(rows.length / catalogPageSize) - 1));
    renderPager('catalog-pages', catalogPage, rows.length, catalogPageSize, 'catalog');
    const headers = {
      chains: ['业务链路', '阶段进度', '触发与结果', '证据'],
      findings: ['发现项', '类型 / 可信度', '结论与影响', '证据'],
      coverage: ['分析维度', '状态', '覆盖说明', '证据'],
      tables: ['实际名称 / 对象', '使用性质', '关系与边界', '源码引用'],
      files: ['源码文件', '所属分组', '路径', '文件'],
      routes: ['接口 / 事件', '处理入口', '说明', '源码'],
      flags: ['源码配置名', '值', '证据范围', '位置']
    }[catalogMode];
    $('catalog-head').innerHTML = `<tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr>`;
    $('catalog-count').textContent = `${rows.length} / ${data[catalogMode].length} 项`;
    $('catalog-body').innerHTML = rows.slice(catalogPage * catalogPageSize, (catalogPage + 1) * catalogPageSize).map(row => {
      if (catalogMode === 'chains') return `<tr><td><button class="text-link strong-link" data-chain="${row.id}">${esc(row.title)}</button><small>${esc(chainKindLabel(row))}</small></td><td><div class="status-stack">${chainBadges(row)}</div><small>${esc(chainProgressLabel(row))}</small></td><td>${esc(row.summary)}<small>${esc(row.trigger)} → ${esc(row.outcome)}</small></td><td><button class="text-link" data-chain="${row.id}">${row.sources.length} 处依据</button></td></tr>`;
      if (catalogMode === 'findings') return `<tr><td><button class="text-link strong-link" data-finding="${row.id}">${esc(row.title)}</button></td><td><div class="status-stack">${statusBadge(row.kind, kindLabels[row.kind])}${statusBadge(row.status)}${freshnessBadge(row)}</div></td><td>${esc(row.summary)}${row.impact ? `<small>${esc(row.impact)}</small>` : ''}</td><td><button class="text-link" data-finding="${row.id}">${row.sources.length} 处依据</button></td></tr>`;
      if (catalogMode === 'coverage') return `<tr><td><button class="text-link strong-link" data-coverage="${row.id}">${esc(row.area)}</button></td><td>${statusBadge(row.status)}${freshnessBadge(row)}</td><td>${esc(row.summary)}${row.nextCheck ? `<small>待确认：${esc(row.nextCheck)}</small>` : ''}</td><td><button class="text-link" data-coverage="${row.id}">${row.sources.length} 处依据</button></td></tr>`;
      if (catalogMode === 'tables') return `<tr><td><code>${esc(row.name)}</code>${freshnessBadge(row)}<small>${esc(row.title)}</small></td><td>${esc(row.kind)}</td><td>${esc(row.description)}</td><td><button class="text-link" data-table="${esc(row.name)}">${row.sources.length} 处依据</button></td></tr>`;
      if (catalogMode === 'files') return `<tr><td><code>${esc(row.name)}</code><small>${row.lines} 行</small></td><td>${esc(row.group)}</td><td><code>${esc(row.path)}</code></td><td><a target="_blank" rel="noopener" href="${fileUrl(row.path)}">打开 · L${row.line}</a></td></tr>`;
      if (catalogMode === 'routes') return `<tr><td><code>${esc(row.prefix)}</code>${freshnessBadge(row)}<small>${esc(row.kind || '')}</small></td><td><code>${esc(row.name)}</code></td><td>${esc(row.description || '')}</td><td><button class="text-link" data-route="${esc(row.prefix)}">${row.sources.length} 处依据</button></td></tr>`;
      return `<tr><td><code>${esc(row.name)}</code>${freshnessBadge(row)}</td><td class="${row.value === true ? 'flag-on' : row.value === false ? 'flag-off' : ''}">${esc(typeof row.value === 'object' ? JSON.stringify(row.value) : row.value)}</td><td>${esc(row.description || '')}</td><td><button class="text-link" data-flag="${esc(row.name)}">${row.sources.length} 处依据</button></td></tr>`;
    }).join('') || '<tr class="empty-row"><td colspan="4">没有匹配的记录</td></tr>';
    $('catalog-body').querySelectorAll('tr:not(.empty-row)').forEach(row => {
      [...row.cells].forEach((cell, index) => { cell.dataset.label = headers[index]; });
    });
  }

  function showTable(name) {
    const table = data.tables.find(item => item.name === name);
    if (!table) return;
    showDialog(table.title, `<p><code>${esc(name)}</code><br>${esc(table.kind)} · ${esc(table.description)}</p><div class="detail-heading">源码引用位置（引用不等于写入）</div>${table.sources.map((source, index) => `<button class="evidence-link" data-table-source="${esc(name)}" data-index="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}`);
  }

  $('module-search').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    $('view-nav').hidden = Boolean(query);
    $('search-results').hidden = !query;
    if (!query) return;
    const views = data.views.filter(view => matchesSearch(view, query)).slice(0, 5);
    const chains = data.chains.filter(chain => matchesSearch(chain, query)).slice(0, 5);
    const modules = data.modules.filter(module => matchesSearch(module, query)).slice(0, 6);
    const findings = data.findings.filter(finding => matchesSearch(finding, query)).slice(0, 5);
    const coverage = data.coverage.filter(item => matchesSearch(item, query)).slice(0, 5);
    const routes = data.routes.filter(route => matchesSearch(route, query)).slice(0, 5);
    const tables = data.tables.filter(table => matchesSearch(table, query)).slice(0, 5);
    const flags = data.flags.filter(flag => matchesSearch(flag, query)).slice(0, 5);
    const files = data.files.filter(file => matchesSearch(file, query)).slice(0, 5);
    const total = ['views', 'modules', ...catalogKinds].reduce((count, kind) => count + data[kind].filter(row => matchesSearch(row, query)).length, 0);
    $('search-results').innerHTML = (total ? `<div class="search-label">共 ${total} 项匹配，每类预览 5 项（模块 6 项）；索引类记录可在证据索引继续筛选。</div>` : '') + ([
      chains.length ? '<div class="search-label">业务链路</div>' + chains.map(chain => `<button class="search-result" data-chain="${chain.id}">${esc(chain.title)}<small>${esc(chain.kind)}</small></button>`).join('') : '',
      views.length ? '<div class="search-label">视图</div>' + views.map(view => `<button class="search-result" data-search-view="${view.id}">${esc(view.title)}<small>${esc(view.group)}</small></button>`).join('') : '',
      modules.length ? '<div class="search-label">模块</div>' + modules.map(module => `<button class="search-result" data-search-module="${module.id}">${esc(module.name)}<small>${esc(module.category)}</small></button>`).join('') : '',
      findings.length ? '<div class="search-label">发现项</div>' + findings.map(finding => `<button class="search-result" data-finding="${finding.id}">${esc(finding.title)}<small>${esc(kindLabels[finding.kind])} · ${esc(statusLabels[finding.status])}</small></button>`).join('') : '',
      coverage.length ? '<div class="search-label">覆盖矩阵</div>' + coverage.map(item => `<button class="search-result" data-coverage="${item.id}">${esc(item.area)}<small>${esc(statusLabels[item.status])}</small></button>`).join('') : '',
      routes.length ? '<div class="search-label">接口 / 事件</div>' + routes.map(route => `<button class="search-result" data-route="${esc(route.prefix)}">${esc(route.prefix)}<small>${esc(route.name)}</small></button>`).join('') : '',
      tables.length ? '<div class="search-label">数据对象</div>' + tables.map(table => `<button class="search-result" data-table="${esc(table.name)}">${esc(table.title)}<small>${esc(table.name)}</small></button>`).join('') : '',
      flags.length ? '<div class="search-label">配置项</div>' + flags.map(flag => `<button class="search-result" data-flag="${esc(flag.name)}">${esc(flag.name)}<small>${esc(typeof flag.value === 'object' ? JSON.stringify(flag.value) : flag.value)}</small></button>`).join('') : '',
      files.length ? '<div class="search-label">代码文件</div>' + files.map(file => `<a class="search-result" target="_blank" rel="noopener" href="${fileUrl(file.path)}">${esc(file.name)}<small>${esc(file.group)}</small></a>`).join('') : ''
    ].join('') || '<div class="search-label">没有匹配的分析内容</div>');
  });

  document.addEventListener('click', event => {
    const reading = event.target.closest('[data-chain-reading]');
    if (reading) {
      const chain = data.chains.find(item => item.id === reading.dataset.chainReading);
      if (chain?.readingView) navigate(chain.readingView);
      return;
    }
    const stageEvidence = event.target.closest('[data-stage-evidence]');
    if (stageEvidence) {
      const chain = data.chains.find(item => item.id === stageEvidence.dataset.stageEvidence);
      const stage = chain?.stages.find(item => item.id === stageEvidence.dataset.stage);
      if (stage) showSourceCollection(`${chain.title} · ${stage.label}`, stage.summary, stage.sources);
      return;
    }
    const openChain = event.target.closest('[data-open-chain]');
    if (openChain) { showChain(openChain.dataset.openChain); return; }
    const chain = event.target.closest('[data-chain]');
    if (chain) {
      closeNav();
      showChain(chain.dataset.chain);
      return;
    }
    const chainView = event.target.closest('[data-chain-view]');
    if (chainView) { dialog.close(); navigate(chainView.dataset.chainView); return; }
    const chainStageSource = event.target.closest('[data-chain-stage-source]');
    if (chainStageSource) {
      const chain = data.chains.find(item => item.id === chainStageSource.dataset.chainStageSource);
      const stage = chain?.stages.find(item => item.id === chainStageSource.dataset.stage);
      if (stage) showEvidence(stage.sources[Number(chainStageSource.dataset.index)]);
      return;
    }
    const chainSource = event.target.closest('[data-chain-source]');
    if (chainSource) { showEvidence(data.chains.find(item => item.id === chainSource.dataset.chainSource).sources[Number(chainSource.dataset.index)]); return; }
    const searchView = event.target.closest('[data-search-view]');
    if (searchView) navigate(searchView.dataset.searchView);
    const searchModule = event.target.closest('[data-search-module]');
    if (searchModule) { closeNav(); inspectModule(searchModule.dataset.searchModule, true); }
    const finding = event.target.closest('[data-finding]');
    if (finding) { closeNav(); showFinding(finding.dataset.finding); }
    const coverage = event.target.closest('[data-coverage]');
    if (coverage) { closeNav(); showCoverage(coverage.dataset.coverage); }
    const findingSource = event.target.closest('[data-finding-source]');
    if (findingSource) showEvidence(data.findings.find(item => item.id === findingSource.dataset.findingSource).sources[Number(findingSource.dataset.index)]);
    const coverageSource = event.target.closest('[data-coverage-source]');
    if (coverageSource) showEvidence(data.coverage.find(item => item.id === coverageSource.dataset.coverageSource).sources[Number(coverageSource.dataset.index)]);
    const table = event.target.closest('[data-table]');
    if (table) { closeNav(); showTable(table.dataset.table); }
    const tableSource = event.target.closest('[data-table-source]');
    if (tableSource) showEvidence(data.tables.find(table => table.name === tableSource.dataset.tableSource).sources[Number(tableSource.dataset.index)]);
    const flag = event.target.closest('[data-flag]');
    if (flag) showEvidenceList(data.flags.find(item => item.name === flag.dataset.flag), 'flags');
    const route = event.target.closest('[data-route]');
    if (route) showEvidenceList(data.routes.find(item => item.prefix === route.dataset.route), 'routes');
    const indexedSource = event.target.closest('[data-index-source]');
    if (indexedSource) showEvidence(data[indexedSource.dataset.indexKind][Number(indexedSource.dataset.row)].sources[Number(indexedSource.dataset.indexSource)]);
    const catalogTab = event.target.closest('[data-catalog]');
    if (catalogTab) {
      catalogMode = catalogTab.dataset.catalog;
      catalogPage = 0;
      $('catalog-search').value = '';
      document.querySelectorAll('[data-catalog]').forEach(button => button.setAttribute('aria-selected', String(button === catalogTab)));
      renderCatalog();
    }
    if (event.target.closest('#copy-mermaid')) copySource();
    if (event.target.closest('#download-mermaid')) download(`${current.title}.mmd`, sourceForCopy, 'text/plain;charset=utf-8');
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-page-target]');
    if (!button || button.disabled) return;
    if (button.dataset.pageTarget === 'catalog') { catalogPage = Number(button.dataset.page); renderCatalog(); }
    else { chainPage = Number(button.dataset.page); renderChains(); }
    const target = button.dataset.pageTarget === 'catalog' ? 'catalog-section' : 'chain-section';
    $(target).scrollIntoView({ block: 'start' });
    const heading = $(target).querySelector('h3'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
  });
  $('catalog-search').addEventListener('input', () => { catalogPage = 0; renderCatalog(); });
  $('chain-filter').addEventListener('change', event => { chainFilter = event.target.value; chainPage = 0; renderChains(); });
  function showEvidenceList(row, kind) {
    const index = data[kind].indexOf(row);
    showDialog('源码依据 · ' + (row.name || row.prefix), `<p>${esc(row.description || '')}</p>${row.sources.map((source, sourceIndex) => `<button class="evidence-link" data-index-kind="${kind}" data-row="${index}" data-index-source="${sourceIndex}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}`);
  }
  $('zoom-in').addEventListener('click', () => zoom(camera.scale * 1.2));
  $('zoom-out').addEventListener('click', () => zoom(camera.scale / 1.2));
  $('zoom-input').addEventListener('change', event => {
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value > 0) zoom(value / 100); else paint();
  });
  $('fit-graph').addEventListener('click', fit);
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('graph-section').requestFullscreen();
      fit();
    } catch { showToast('当前浏览器未允许全屏'); }
  });
  $('export-svg').addEventListener('click', exportSvg);
  $('toggle-flow').addEventListener('click', () => {
    flowPreference = !(flowPreference ?? !reducedMotion.matches);
    syncFlowPlayback();
  });
  $('show-source').addEventListener('click', showMermaidSource);
  $('show-view-evidence').addEventListener('click', () => showSourceCollection('本视图源码依据', current.subtitle, current.sources || []));
  $('about-button').addEventListener('click', showAbout);
  $('update-button').addEventListener('click', showUpdate);
  $('copy-view-link').addEventListener('click', () => {
    const reach = new URLSearchParams(location.hash.slice(1)).get('reach');
    copyLink({ view: current.id, focus: selectedModule || undefined, reach: selectedModule && ['upstream', 'downstream'].includes(reach) ? reach : undefined, table: selectedTable || undefined, chain: selectedStage?.chain, stage: selectedStage?.stage });
  });
  $('clear-focus').addEventListener('click', () => {
    selectedModule = null; selectedStage = null; selectedTable = null;
    if (current.tables?.length) renderDataOverview(current); else renderArchitectureOverview(current);
    syncDiagramSelection(); fit();
    updateReadingHash({ view: current.id });
  });
  $('copy-detail-link').addEventListener('click', () => { if (dialog._route) copyLink(dialog._route); });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-copy-stage]');
    if (!button) return;
    const chain = data.chains.find(row => row.id === button.dataset.copyStage);
    copyLink({ view: chain.readingView || current.id, chain: chain.id, stage: button.dataset.stage });
  });
  $('close-dialog').addEventListener('click', () => dialog.close());
  $('dialog-back').addEventListener('click', backDialog);
  dialog.addEventListener('close', () => { if (dialog.open) return; dialogHistory.length = 0; dialog._directSources = null; $('dialog-back').hidden = true; });
  $('overview-link').addEventListener('click', () => navigate(overviewId));
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  $('open-nav').addEventListener('click', () => { $('sidebar').classList.add('is-open'); $('nav-backdrop').hidden = false; $('open-nav').setAttribute('aria-expanded', 'true'); });
  $('close-nav').addEventListener('click', closeNav);
  $('nav-backdrop').addEventListener('click', closeNav);
  window.addEventListener('hashchange', restoreLocation);
  smallScreen.addEventListener('change', () => {
    if (!current) return;
    const viewId = current.id, previousStage = selectedStage, previousModule = selectedModule, previousTable = selectedTable;
    const scrollTop = window.scrollY, readerScroll = $('reading-panel').scrollTop;
    const rendering = navigate(viewId, false, { preserveScroll: true });
    const responsiveSerial = renderSerial;
    if (previousStage) selectStage(previousStage.chain, previousStage.stage, { updateHash: false });
    else if (previousTable) inspectDataObject(previousTable, { updateHash: false });
    else if (previousModule && current.id !== 'catalog') {
      selectedModule = previousModule;
      renderModuleReader(byId(previousModule));
    }
    $('reading-panel').scrollTop = readerScroll;
    rendering.then(() => { if (current.id === viewId && renderSerial === responsiveSerial) window.scrollTo({ top: scrollTop, behavior: 'instant' }); });
  });
  compactLayout.addEventListener('change', () => showVisualPane());
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches && flowPreference === true) flowPreference = null;
    syncFlowPlayback();
  });
  printMedia.addEventListener('change', syncFlowPlayback);
  document.addEventListener('visibilitychange', syncFlowPlayback);
  window.addEventListener('beforeprint', () => { printing = true; syncFlowPlayback(); });
  window.addEventListener('afterprint', () => { printing = false; syncFlowPlayback(); });
  window.addEventListener('pagehide', stopFlowFrame);
  window.addEventListener('pageshow', syncFlowPlayback);
  new IntersectionObserver(entries => {
    flowInView = entries.some(entry => entry.isIntersecting);
    syncFlowPlayback();
  }).observe(viewport);
  collapsedNavigation.addEventListener('change', () => { if (!collapsedNavigation.matches) closeNav(); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNav();
    if (event.key === '/' && !dialog.open && !event.target.matches('input, textarea, select, [contenteditable="true"]')) {
      event.preventDefault();
      $('module-search').focus();
    }
  });
  new ResizeObserver(scheduleGraphLayout).observe(viewport);
  window.addEventListener('resize', scheduleGraphLayout);
  document.addEventListener('fullscreenchange', () => { fitMode = true; scheduleGraphLayout(); });
  $('baseline-date').textContent = data.date;
  $('stat-modules').textContent = data.stats.modules;
  $('stat-diagrams').textContent = data.stats.diagrams;
  $('stat-chains').textContent = data.stats.chains || data.chains.length || 0;
  $('stat-findings').textContent = data.stats.findings || 0;
  $('stat-coverage').textContent = data.stats.coverage || 0;
  $('stat-evidence').textContent = data.stats.evidence || 0;
  $('stat-files').textContent = data.stats.files;
  if (data.update) {
    const summary = data.update.summary || {};
    $('update-button').hidden = false;
    $('update-label').textContent = summary.manifestChanged && !summary.changedFiles ? '分析清单已更新' : `${summary.changedFiles || 0} 个增量变更`;
    $('update-button').classList.toggle('is-warning', Boolean(data.update.reviewRequired));
  } else if (data.review) {
    $('update-button').hidden = false;
    $('update-label').textContent = '已复核';
  }
  $('review-banner').hidden = !data.reviewMode;
  $('review-banner').textContent = `仅供复核 · ${data.unresolvedCount || 0} 处证据未解析。候选结论尚需逐项确认。`;
  $('open-findings').disabled = !data.findings.length;
  $('open-coverage').disabled = !data.coverage.length;
  $('open-chains').disabled = !data.chains.length;
  $('footer-baseline').textContent = data.repositories.map(repo => repo.name + ' ' + repo.commit).join(' / ');
  $('footer-boundary').textContent = data.project.boundary;
  renderChains();
  renderQuality();
  renderHighlights();
  $('project-summary').textContent = data.project.summary || data.project.scope;
  $('project-scope').textContent = `分析范围：${data.project.scope}`;
  $('project-scope').hidden = false;
  $('reading-boundary').textContent = data.project.boundary;
  $('project-title').textContent = data.project.title;
  $('project-title').title = data.project.title;
    $('project-subtitle').textContent = data.project.subtitle === 'REPOSITORY ATLAS' ? '项目架构与业务流程' : data.project.subtitle;
  document.title = data.project.title;
  document.querySelectorAll('[data-catalog]').forEach(button => {
    button.hidden = !catalogKinds.includes(button.dataset.catalog);
    button.setAttribute('aria-selected', String(button.dataset.catalog === catalogMode));
  });
  function openCatalog(kind) {
    if (!catalogKinds.includes(kind)) return;
    catalogMode = kind;
    catalogPage = 0;
    navigate('catalog');
    document.querySelectorAll('[data-catalog]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.catalog === kind)));
    renderCatalog();
  }
  const jumpToReadingSection = id => {
    const section = $(id);
    section.scrollIntoView({ block: 'start' });
    const heading = section.querySelector('h3');
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
  };
  $('read-flows').hidden = !data.chains.length;
  const dataFlowView = data.views.find(view => view.kind === 'data_flow') || data.views.find(view => view.relationDiagrams?.data_flow?.relations.length);
  const structureView = data.views.find(view => view.kind === 'data');
  $('read-dataflow').hidden = !dataFlowView;
  $('read-structures').hidden = !structureView;
  $('read-flows').addEventListener('click', () => jumpToReadingSection('chain-section'));
  $('read-dataflow').addEventListener('click', () => current.id === dataFlowView.id ? jumpToReadingSection('visual-section') : navigate(dataFlowView.id));
  $('read-structures').addEventListener('click', () => navigate(structureView.id));
  $('open-findings').addEventListener('click', () => openCatalog('findings'));
  $('all-findings').addEventListener('click', () => openCatalog('findings'));
  $('open-coverage').addEventListener('click', () => openCatalog('coverage'));
  $('open-chains').addEventListener('click', () => openCatalog('chains'));
  nav();
  icons();
  window.repoAtlas = { navigate, data, fit, shareUrl, focusModule: (id, options = {}) => inspectModule(id, options.modal ?? false, options), showAuthoredRoute, authoredRoute, get currentView() { return current?.id; }, get camera() { return { ...camera }; }, get selectedModule() { return selectedModule; } };
  restoreLocation();
})();
