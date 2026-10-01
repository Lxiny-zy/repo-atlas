(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('graph-data').textContent);
  data.findings ||= [];
  data.coverage ||= [];
  data.chains ||= [];
  data.update ||= null;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = name => `<i data-lucide="${esc(name)}"></i>`;
  const icons = () => window.lucide.createIcons();
  const byId = id => data.modules.find(module => module.id === id);
  for (const module of data.modules) module.links ||= [];
  const moduleLinkIds = module => (module?.links || []).filter(id => byId(id));
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
  let renderSerial = 0;
  let renderQueue = Promise.resolve();
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
  for (const kind of ['modules', 'views', 'chains', 'findings', 'coverage', 'tables', 'routes', 'flags']) {
    for (const row of data[kind]) {
      for (const source of row.sources || []) if (source.key) evidenceTargets.set(source.key, { source, view: kind === 'views' ? row.id : kind === 'chains' ? row.readingView : overviewId, ...(kind === 'chains' ? { chain: row.id } : {}) });
      if (kind === 'chains') for (const stage of row.stages) for (const source of stage.sources) if (source.key) evidenceTargets.set(source.key, { source, view: row.readingView || overviewId, chain: row.id, stage: stage.id });
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
  const smallScreen = window.matchMedia('(max-width: 800px)');
  const kindLabels = { fact: '事实', risk: '风险', gap: '缺口', decision: '决策' };
  const statusLabels = { confirmed: '已确认', inferred: '推断', unverified: '待验证', covered: '已覆盖', partial: '部分覆盖', unknown: '待确认', not_applicable: '不适用' };
  const statusBadge = (value, label = statusLabels[value] || value) => `<span class="status-badge status-${esc(value)}">${esc(label)}</span>`;
  const needsReview = row => Boolean(row?.reviewRequired || ['stale', 'unresolved', 'historical'].includes(row?.freshness) || row?.sources?.some(source => source.state === 'unresolved'));
  const freshnessBadge = row => needsReview(row) ? statusBadge('stale', { unresolved: '证据未解析', historical: '历史证据' }[row.freshness] || '待复核') : '';
  const stageKindLabels = { entry: '入口', authorization: '权限', validation: '校验', orchestration: '业务编排', read: '读取', write: '写入', side_effect: '外部副作用', publication: '发布', consume: '消费', outcome: '结果', recovery: '失败恢复', custom: '处理' };
  const stageKindLabel = stage => stageKindLabels[stage.kind || 'custom'] || stage.kind;
  const chainKindLabel = chain => ({ user_flow: '用户流程', event_flow: '事件处理', batch: '批处理', recovery: '失败恢复' }[chain.kind] || chain.kind);

  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base',
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

  function showEvidence(source) {
    if (!source) return;
    const context = dialog.open ? $('dialog-title').textContent : current?.title;
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

  function isSequenceView(view) {
    return view?.kind === 'sequence' || view?.kind === 'narrative' || /^\s*sequenceDiagram\b/.test(view?.diagram || '');
  }

  function renderSequenceDescription(view) {
    const section = $('sequence-section');
    const linkedChains = view.chainIds?.length
      ? view.chainIds.map(id => data.chains.find(chain => chain.id === id)).filter(Boolean)
      : data.chains.filter(chain => chain.views?.includes(view.id));
    section.hidden = false;
    $('sequence-count').textContent = linkedChains.length ? `${linkedChains.length} 条链路` : '自然语言流程';
    $('sequence-intro').textContent = linkedChains.length
      ? '按业务阶段阅读触发、处理、写入和结果；每一步都保留对应源码依据。'
      : '当前视图没有绑定业务链路，以下说明来自视图备注；需要补充阶段证据时请更新 atlas.json。';
    $('sequence-list').innerHTML = linkedChains.length ? linkedChains.map(chain => {
      const stages = chain.stages || [];
      return `<article class="sequence-card" data-narrative-chain="${chain.id}"><div class="sequence-card-head"><div><span class="eyebrow">${esc(chainKindLabel(chain))}</span><h4>${esc(chain.title)}</h4></div><div class="status-stack">${chainBadges(chain)}</div></div>
        <p class="sequence-summary">${esc(chain.summary)}</p>
        <div class="sequence-route"><strong>触发</strong><span>${esc(chain.trigger)}</span><b>→</b><strong>结果</strong><span>${esc(chain.outcome)}</span></div>
        <p class="chain-coverage-summary">${esc(chainProgressLabel(chain))}</p>
        <ol class="sequence-steps">${stages.map((stage, index) => `<li data-stage-anchor="${chain.id}/${stage.id}"><span class="sequence-step-index">${index + 1}</span><div><div class="sequence-step-title"><strong>${esc(stage.label)}</strong><span class="chain-stage-kind">${esc(stageKindLabel(stage))}</span>${statusBadge(stage.status)}${freshnessBadge(stage)}<button class="text-link stage-permalink" data-copy-stage="${chain.id}" data-stage="${stage.id}" aria-label="复制阶段链接">${icon('link')}</button></div><p>${esc(stage.summary)}</p>${stage.nextCheck ? `<small>待确认：${esc(stage.nextCheck)}</small>` : ''}${stage.sources?.length ? `<button class="text-link sequence-evidence" data-stage-evidence="${chain.id}" data-stage="${stage.id}">${icon('file-code-2')}查看 ${stage.sources.length} 处源码依据</button>` : ''}</div></li>`).join('')}</ol>
        <button class="text-link sequence-open-chain" data-open-chain="${esc(chain.id)}">查看链路证据与关联模块</button>
      </article>`;
    }).join('') : `<div class="sequence-card sequence-card-empty"><p>${esc(view.subtitle || '请在视图备注中补充流程的触发、处理和结果。')}</p>${(view.notes || []).map(([title, text]) => `<div class="sequence-note"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`).join('')}</div>`;
    icons();
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
  }

  function navigate(id, updateHash = true) {
    const view = data.views.find(item => item.id === id) || data.views[0];
    current = view;
    selectedModule = null;
    window.scrollTo({ top: 0, behavior: 'instant' });
    viewport.style.height = '';
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
    $('view-group').textContent = `项目图谱 / ${view.group}`;
    $('view-title').textContent = view.title;
    $('view-subtitle').textContent = view.freshness === 'stale' ? `${view.subtitle} · 待复核` : view.subtitle;
    $('view-tags').innerHTML = view.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('');
    $('show-view-evidence').hidden = !view.sources?.length;
    const legend = view.legend || (/^\s*(flowchart|graph)\s/.test(view.diagram || '') ? [
      { label: '入口', color: '#a8bfe4' }, { label: '业务', color: '#8ebba6' },
      { label: '处理 / 流程', color: '#ddbc7c' }, { label: '外部依赖', color: '#d4a498' }
    ] : []);
    $('view-legend').innerHTML = legend.map(item => `<span><b class="swatch" style="background:${/^#[a-fA-F0-9]{6}$/.test(item.color) ? item.color : '#89958c'}"></b>${esc(item.label)}</span>`).join('');
    $('view-notes').innerHTML = view.notes.map(([title, text]) => `<article class="fact-item"><h3>${esc(title)}</h3><p>${esc(text)}</p></article>`).join('');
    $('view-notes').hidden = !view.notes.length;
    $('module-detail').hidden = true;
    $('module-section').hidden = view.id === 'catalog';
    $('module-list').innerHTML = view.modules.map(id => {
      const module = byId(id);
      return `<button class="module-row" data-module="${id}" aria-expanded="false">${icon(module.icon)}<span>${esc(module.name)}</span><small>${esc(module.category)}</small>${icon('chevron-right')}</button>`;
    }).join('');
    $('module-count').textContent = `${view.modules.length} 项`;
    $('alias-section').hidden = !view.aliases;
    $('alias-list').innerHTML = Object.entries(view.aliases || {}).map(([name, table]) => `<div class="alias-row"><strong>${esc(name)}</strong><code>${esc(table)}</code></div>`).join('');
    const sequenceView = isSequenceView(view);
    $('graph-section').hidden = !view.diagram || sequenceView;
    $('sequence-section').hidden = !sequenceView;
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
    if (sequenceView) {
      renderSerial++;
      viewport.dataset.renderState = 'ready';
      $('graph-status').hidden = true;
      stage.replaceChildren();
      camera = { x: 0, y: 0, scale: 1 };
      renderSequenceDescription(view);
      icons();
      return Promise.resolve();
    }
    $('diagram-kind').textContent = view.diagram.trimStart().startsWith('erDiagram') ? '数据对象关系 / 约束以说明为准' : view.diagram.trimStart().startsWith('stateDiagram') ? '状态与动作' : view.diagram.trimStart().startsWith('mindmap') ? '模块职责树' : '调用与数据流 / 以图中边标注为准';
    const visibleDiagrams = data.views.filter(item => item.diagram && !isSequenceView(item));
    $('diagram-counter').textContent = `${String(visibleDiagrams.indexOf(view) + 1).padStart(2, '0')} / ${data.stats.diagrams}`;
    $('canvas-stamp').textContent = `${data.renderer} · ${data.date}`;
    icons();
    const serial = ++renderSerial;
    const diagram = smallScreen.matches && view.mobileDiagram ? view.mobileDiagram : view.diagram;
    renderedDiagram = diagram;
    const cacheKey = `${view.id}::${diagram === view.mobileDiagram ? 'mobile' : 'desktop'}`;
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
        const widthScale = Math.min(1, (viewport.clientWidth - 44) / diagramSize.width);
        if (!smallScreen.matches && diagramSize.height / diagramSize.width > 0.8) {
          viewport.style.height = Math.min(1440, Math.max(viewport.clientHeight, diagramSize.height * widthScale + 44)) + 'px';
        } else if (smallScreen.matches && view.mobileDiagram) {
          viewport.style.height = Math.min(1100, Math.max(430, diagramSize.height * widthScale + 44)) + 'px';
        } else if (!smallScreen.matches) {
          const readableHeight = diagramSize.height * Math.min(1.5, (viewport.clientWidth - 44) / diagramSize.width) + 88;
          if (readableHeight < viewport.clientHeight * 0.65) viewport.style.height = Math.max(260, readableHeight) + 'px';
        }
        element.style.width = diagramSize.width + 'px';
        element.style.height = diagramSize.height + 'px';
        element.setAttribute('width', diagramSize.width);
        element.setAttribute('height', diagramSize.height);
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', view.title);
        element.querySelectorAll('g.node').forEach(node => {
          const nodeId = node.id.match(/^flowchart-(.+)-\d+$/)?.[1];
          if (nodeId && byId(nodeId)) {
            node.dataset.module = nodeId;
            node.setAttribute('tabindex', '0');
            node.setAttribute('role', 'button');
            node.setAttribute('aria-label', byId(nodeId).name + '，源码依据');
          }
        });
        fit();
        $('graph-status').hidden = true;
        $('export-svg').disabled = false;
        viewport.dataset.renderState = 'ready';
        viewport.dataset.view = view.id;
      } catch (error) {
        if (serial !== renderSerial) return;
        stage.replaceChildren();
        stage.innerHTML = `<div class="diagram-fallback"><strong>关系图暂时无法渲染</strong><p>保留 Mermaid 源码，流程说明和证据索引仍可继续查看。</p><pre>${esc(diagram)}</pre></div>`;
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

  function fit() {
    fitMode = true;
    camera.scale = Math.max(0.05, Math.min((viewport.clientWidth - 44) / diagramSize.width, (viewport.clientHeight - 44) / diagramSize.height, 1.5));
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
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    moved = false;
    pointerModule = event.target.closest('[data-module]')?.dataset.module || null;
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
    pointers.delete(event.pointerId);
    previousPinch = null;
    if (!pointers.size) viewport.classList.remove('is-dragging');
    pointerModule = null;
    if (clickedModule) inspectModule(clickedModule, true);
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
    if (event.target.matches('[data-module]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      inspectModule(event.target.dataset.module, true);
      return;
    }
    const offsets = { ArrowLeft: [35, 0], ArrowRight: [-35, 0], ArrowUp: [0, 35], ArrowDown: [0, -35] };
    if (offsets[event.key]) {
      event.preventDefault();
      const [x, y] = offsets[event.key];
      camera.x += x; camera.y += y; fitMode = false; paint();
    }
  });

  function legacyModuleMarkup(module) {
    return `<div class="module-detail-heading"><h3>${esc(module.name)}</h3><span class="status-stack"><span class="tag">${esc(module.category)}</span>${freshnessBadge(module)}</span></div><p class="summary">${esc(module.summary)}</p>${module.staleReason ? `<p class="stale-note">${esc(module.staleReason)}</p>` : ''}<ul>${module.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul><div class="detail-grid"><div><div class="detail-heading">关联职责</div><div class="related-links">${module.links.map(id => byId(id) ? `<button class="text-link" data-inspect-module="${id}">${esc(byId(id).name)}</button>` : '').join('')}</div></div><div><div class="detail-heading">源码依据</div>${module.sources.map((source, index) => `<button class="evidence-link" data-evidence-module="${module.id}" data-source="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">${sourceLocation(source)} · ${esc(source.path.split('/')[0])}</span></span></button>`).join('')}</div></div>`;
  }

  function sourceListMarkup(sources) {
    return sources.map((source, index) => `<button class="evidence-link" data-direct-source="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('');
  }

  function modulePassportMarkup(module, focusReach) {
    const upstream = authoredNeighbors(module.id, 'upstream');
    const downstream = authoredNeighbors(module.id, 'downstream');
    const list = (items, direction) => items.length
      ? `<div class="passport-links">${items.map(item => `<button class="passport-link" data-focus-module="${item.id}" data-focus-reach="${direction}">${icon(direction === 'upstream' ? 'arrow-up-left' : 'arrow-down-right')}<span>${esc(item.name)}</span></button>`).join('')}</div>`
      : `<p class="passport-empty">${direction === 'upstream' ? '没有已记录的上游职责' : '没有已记录的下游职责'}</p>`;
    const routePairs = upstream.flatMap(source => downstream.map(target => [source, target])).slice(0, 8);
    return `<section class="module-passport" aria-label="${esc(module.name)} 的 authored 关系护照">
      <div class="passport-heading"><div><div class="detail-heading">关系护照</div><p>只展示 <code>atlas.json</code> 中已记录的 authored relationship，不代表运行时调用、影响范围或合并安全性。</p></div><button class="text-link module-copy-link" data-copy-focus="${module.id}" data-focus-reach="${esc(focusReach || '')}">${icon('link')}复制焦点链接</button></div>
      <div class="passport-stats"><span><strong>${upstream.length}</strong> 上游职责</span><span><strong>${downstream.length}</strong> 下游职责</span><span><strong>${upstream.length + downstream.length}</strong> 直接关系</span></div>
      <div class="passport-columns"><div><h4>上游职责</h4>${list(upstream, 'upstream')}</div><div><h4>下游职责</h4>${list(downstream, 'downstream')}</div></div>
      ${routePairs.length ? `<div class="passport-routes"><h4>有限 authored 路径</h4><div class="passport-links">${routePairs.map(([source, target]) => `<button class="passport-link passport-route-link" data-authored-route="${esc(source.id + '~' + target.id)}">${icon('route')}<span>${esc(source.name)} → ${esc(target.name)}</span></button>`).join('')}</div></div>` : ''}
    </section>`;
  }

  function moduleMarkup(module, options = {}) {
    const focusReach = options.focusReach;
    const related = moduleLinkIds(module);
    return `<div class="module-detail-heading"><h3>${esc(module.name)}</h3><span class="status-stack"><span class="tag">${esc(module.category)}</span>${freshnessBadge(module)}</span></div><p class="summary">${esc(module.summary)}</p>${module.staleReason ? `<p class="stale-note">${esc(module.staleReason)}</p>` : ''}<ul>${module.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul>${modulePassportMarkup(module, focusReach)}<div class="detail-grid"><div><div class="detail-heading">关联职责</div><div class="related-links">${related.map(item => `<button class="text-link" data-focus-module="${item.id}">${esc(item.name)}</button>`).join('')}</div></div><div><div class="detail-heading">源码依据</div>${module.sources.map((source, index) => `<button class="evidence-link" data-evidence-module="${module.id}" data-source="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">${sourceLocation(source)} · ${esc(source.path.split('/')[0])}</span></span></button>`).join('')}</div></div>`;
  }

  function showSourceCollection(title, description, sources) {
    showDialog(title, `<p>${esc(description || '')}</p><div class="detail-heading">源码依据 · ${sources.length} 处</div>${sourceListMarkup(sources)}`, sources);
  }

  function findingMarkup(finding) {
    const related = finding.modules.map(id => byId(id)).filter(Boolean);
    return `<div class="detail-status">${statusBadge(finding.kind, kindLabels[finding.kind])}${statusBadge(finding.status)}${freshnessBadge(finding)}</div>
      <p>${esc(finding.summary)}</p>
      ${finding.staleReason ? `<p class="stale-note">${esc(finding.staleReason)}</p>` : ''}
      ${finding.impact ? `<h4>影响</h4><p>${esc(finding.impact)}</p>` : ''}
      ${finding.nextCheck ? `<h4>最短验证路径</h4><p>${esc(finding.nextCheck)}</p>` : ''}
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
      <p>${esc(chain.summary)}</p><div class="chain-route"><strong>触发</strong><span>${esc(chain.trigger)}</span><b>→</b><strong>结果</strong><span>${esc(chain.outcome)}</span></div>
      <h4>阶段证据</h4><div class="chain-stage-list">${chain.stages.map(stage => `<div class="chain-stage"><div><strong>${esc(stage.label)}</strong><span class="chain-stage-kind">${esc(stageKindLabel(stage))}</span>${statusBadge(stage.status)}${freshnessBadge(stage)}<button class="text-link stage-permalink" data-copy-stage="${chain.id}" data-stage="${stage.id}" aria-label="复制阶段链接">${icon('link')}</button></div><p>${esc(stage.summary)}</p>${stage.nextCheck ? `<small>待确认：${esc(stage.nextCheck)}</small>` : ''}${stage.sources?.length ? `<div class="chain-stage-sources">${stage.sources.map((source, index) => `<button class="evidence-link" data-chain-stage-source="${chain.id}" data-stage="${stage.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">${sourceLocation(source)}</span></span></button>`).join('')}</div>` : ''}</div>`).join('')}</div>
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
    return `<div class="detail-status"><span class="tag">authored relationship</span><span class="tag">${path.length - 1} ${path.length - 1 === 1 ? 'hop' : 'hops'}</span></div><p>这是一条沿 <code>modules.links</code> 计算的有限路径，仅表示仓库清单中记录的关系，不等同于运行时调用路径、blast radius 或部署拓扑。</p><ol class="authored-route">${path.map((id, index) => { const module = byId(id); return `<li><span class="route-index">${index + 1}</span><button class="text-link strong-link" data-focus-module="${module.id}">${esc(module.name)}</button><small>${esc(module.category)}</small>${index < path.length - 1 ? '<span class="route-arrow" aria-hidden="true">→</span>' : ''}</li>`; }).join('')}</ol><p class="passport-disclaimer">起点：${esc(source.name)}；终点：${esc(target.name)}。路径只沿 authored 边向下搜索，并在遇到环时停止扩展。</p>`;
  }

  function showAuthoredRoute(value, updateHash = true) {
    const pair = routePair(value);
    const path = pair ? authoredRoute(pair[0], pair[1]) : null;
    if (!pair || !path) { showToast('未找到可用的 authored 路径'); return; }
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
    const focusReach = ['upstream', 'downstream'].includes(route.reach) ? route.reach : null;
    const routePairValue = route.route;
    const authoredPair = routePairValue ? routePair(routePairValue) : null;
    const authoredPath = authoredPair ? authoredRoute(authoredPair[0], authoredPair[1]) : null;
    navigate(route.view || chain?.readingView || target?.view || overviewId, false);
    if ((route.chain && !chain) || (route.stage && !stage) || (route.evidence && !target) || (route.focus && !focus) || (route.reach && !focusReach) || (route.route && (!authoredPair || !authoredPath)) || (target && route.chain && target.chain !== route.chain) || (target && route.stage && target.stage !== route.stage) || (route.view && !data.views.some(view => view.id === route.view))) {
      showToast('定位目标不存在，已显示可用视图。'); return;
    }
    if (stage) {
      const element = [...document.querySelectorAll('[data-stage-anchor]')].find(element => element.dataset.stageAnchor === chain.id + '/' + stage.id);
      if (element) { element.classList.add('is-target'); element.tabIndex = -1; element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }); }
    }
    if (chain && !stage) showChain(chain.id);
    if (target) {
      if (chain && !dialog.open) showChain(chain.id);
      showEvidence(target.source);
    }
    if (focus) inspectModule(focus.id, current.id === 'catalog', { focusReach, updateHash: false });
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
      return `<article class="chain-card"><div class="chain-card-head"><div><span class="eyebrow">${esc(chainKindLabel(chain))}</span><h4><button class="chain-title-link" data-chain-reading="${chain.id}">${esc(chain.title)}</button></h4></div><div class="status-stack">${chainBadges(chain)}</div></div><p>${esc(chain.summary)}</p><div class="chain-endpoints"><span><strong>触发</strong>${esc(chain.trigger)}</span><span><strong>结果</strong>${esc(chain.outcome)}</span></div><div class="chain-progress" aria-hidden="true"><span style="width:${progress.percent}%"></span></div><p class="chain-coverage-summary">${esc(chainProgressLabel(chain))}</p><div class="chain-meta"><button class="text-link" data-chain-reading="${chain.id}">阅读流程 ${icon('arrow-right')}</button><button class="text-link" data-chain="${chain.id}">查看证据</button></div></article>`;
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
    $('finding-highlights').innerHTML = findings.map(finding => `<article class="finding-highlight"><div class="status-stack">${statusBadge(finding.kind, kindLabels[finding.kind])}${statusBadge(finding.status)}${freshnessBadge(finding)}</div><h4><button class="text-link strong-link" data-finding="${finding.id}">${esc(finding.title)}</button></h4><p>${esc(finding.summary)}</p></article>`).join('');
  }

  function inspectModule(id, modal = false, options = {}) {
    const module = byId(id);
    if (!module) return;
    selectedModule = id;
    stage.querySelectorAll('[data-module]').forEach(node => node.classList.toggle('is-selected', node.dataset.module === id));
    const route = { view: current?.id || overviewId, focus: module.id, reach: options.focusReach };
    if (options.updateHash !== false) updateReadingHash(route);
    if (modal || current.id === 'catalog' || dialog.open) {
      showDialog(module.name, moduleMarkup(module, options), null, route);
    } else {
      $('module-detail').innerHTML = moduleMarkup(module, options);
      $('module-detail').hidden = false;
      $('module-list').querySelectorAll('[data-module]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.module === id)));
      icons();
      $('module-detail').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  document.addEventListener('click', event => {
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
    svg.querySelectorAll('[tabindex]').forEach(node => node.removeAttribute('tabindex'));
    svg.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected'));
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
  $('show-source').addEventListener('click', showMermaidSource);
  $('show-view-evidence').addEventListener('click', () => showSourceCollection('本视图源码依据', current.subtitle, current.sources || []));
  $('about-button').addEventListener('click', showAbout);
  $('update-button').addEventListener('click', showUpdate);
  $('copy-view-link').addEventListener('click', () => copyLink({ view: current.id }));
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
  $('open-nav').addEventListener('click', () => { $('sidebar').classList.add('is-open'); $('nav-backdrop').hidden = false; });
  $('close-nav').addEventListener('click', closeNav);
  $('nav-backdrop').addEventListener('click', closeNav);
  window.addEventListener('hashchange', restoreLocation);
  smallScreen.addEventListener('change', () => { if (current) navigate(current.id, false); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNav();
    if (event.key === '/' && !dialog.open && !event.target.matches('input, textarea, select, [contenteditable="true"]')) {
      event.preventDefault();
      $('module-search').focus();
    }
  });
  new ResizeObserver(() => { if (fitMode && current?.diagram && viewport.clientWidth > 0) fit(); }).observe(viewport);
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
  $('project-scope').hidden = !data.project.summary;
  $('project-title').textContent = data.project.title;
  $('project-subtitle').textContent = data.project.subtitle;
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
  $('open-findings').addEventListener('click', () => openCatalog('findings'));
  $('all-findings').addEventListener('click', () => openCatalog('findings'));
  $('open-coverage').addEventListener('click', () => openCatalog('coverage'));
  $('open-chains').addEventListener('click', () => openCatalog('chains'));
  nav();
  icons();
  window.repoAtlas = { navigate, data, fit, shareUrl, focusModule: (id, options = {}) => inspectModule(id, options.modal ?? false, options), showAuthoredRoute, authoredRoute, get currentView() { return current?.id; }, get camera() { return { ...camera }; }, get selectedModule() { return selectedModule; } };
  restoreLocation();
})();
