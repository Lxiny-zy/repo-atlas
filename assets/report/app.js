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
  const fileUrl = path => data.sourceBase.split('/').map(encodeURIComponent).join('/') + path.split('/').map(encodeURIComponent).join('/');
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
  let toastTimer;
  let moved = false;
  let sourceForCopy = '';
  let renderedDiagram = '';
  const cache = new Map();
  const smallScreen = window.matchMedia('(max-width: 800px)');
  const kindLabels = { fact: '事实', risk: '风险', gap: '缺口', decision: '决策' };
  const statusLabels = { confirmed: '已确认', inferred: '推断', unverified: '待验证', covered: '已覆盖', partial: '部分覆盖', unknown: '待确认', not_applicable: '不适用' };
  const statusBadge = (value, label = statusLabels[value] || value) => `<span class="status-badge status-${esc(value)}">${esc(label)}</span>`;
  const freshnessBadge = row => row?.freshness === 'stale' ? statusBadge('stale', '待复核') : '';

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
    sequence: { useMaxWidth: false, actorMargin: 28, width: 130, height: 40, messageMargin: 27, noteMargin: 8, diagramMarginX: 15, diagramMarginY: 12, wrap: true },
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

  function showDialog(title, body) {
    $('dialog-title').textContent = title;
    $('dialog-body').innerHTML = body;
    if (!dialog.open) dialog.showModal();
    icons();
  }

  function showEvidence(source) {
    showDialog('源码依据', `<p>${esc(source.path)}<br>起始行 <strong>L${source.line}</strong></p><pre>${esc(source.excerpt || '此项为源码索引，完整内容见对应文件。')}</pre><a href="${fileUrl(source.path)}" target="_blank" rel="noopener">${icon('external-link')} 打开源码文件</a>`);
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
    if (!update) return;
    const summary = update.summary || {};
    const stale = update.staleEvidence || [];
    const manifestChanged = Boolean(summary.manifestChanged);
    showDialog('快照后的增量变更', `<p>这是基于上次快照生成的增量候选，不代表所有结论已经重新确认。</p>
      <div class="baseline-row"><strong>变更文件</strong><span>${summary.changedFiles || 0}（新增 ${summary.added || 0} / 修改 ${summary.modified || 0} / 删除 ${summary.deleted || 0}${summary.renamed ? ` / 重命名 ${summary.renamed}` : ''}）</span></div>
      <div class="baseline-row"><strong>变更占比</strong><span>${Math.round((summary.changedFileRatio || 0) * 1000) / 10}%</span></div>
      <div class="baseline-row"><strong>受影响对象</strong><span>${summary.impactedEntities || update.impacted?.length || 0}</span></div>
      <div class="baseline-row"><strong>待复核证据</strong><span>${summary.staleEvidence || stale.length}</span></div>
      <div class="baseline-row"><strong>可复用证据</strong><span>${summary.reusedEvidence || 0}</span></div>
      <div class="baseline-row"><strong>需重新核对</strong><span>${summary.recomputedEvidence || 0}</span></div>
      <div class="baseline-row"><strong>清单变化</strong><span>${manifestChanged ? '是，需复核' : '否'}</span></div>
      <div class="baseline-row"><strong>全量重分析</strong><span>${summary.fullReanalysisRecommended ? '建议执行' : '当前不需要'}</span></div>
      ${summary.fullReanalysisReasons?.length ? `<div class="stale-note">${summary.fullReanalysisReasons.map(reason => esc(reason)).join('<br>')}</div>` : ''}
      ${stale.length ? `<h4>待复核项</h4><ul>${stale.slice(0, 20).map(item => `<li>${esc(item.entity)} · ${esc(item.path)} · ${esc(item.reason)}</li>`).join('')}</ul>` : '<p>没有检测到失效证据。</p>'}
      <p class="update-note">候选文件：${esc(update.deltaPath || '未记录')}<br>基线：${esc(update.baseSnapshot || '未记录')}</p>`);
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
    if (updateHash && location.hash !== '#' + view.id) history.replaceState(null, '', '#' + view.id);
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
    $('module-detail').hidden = true;
    $('module-section').hidden = view.id === 'catalog';
    $('module-list').innerHTML = view.modules.map(id => {
      const module = byId(id);
      return `<button class="module-row" data-module="${id}" aria-expanded="false">${icon(module.icon)}<span>${esc(module.name)}</span><small>${esc(module.category)}</small>${icon('chevron-right')}</button>`;
    }).join('');
    $('module-count').textContent = `${view.modules.length} 项`;
    $('alias-section').hidden = !view.aliases;
    $('alias-list').innerHTML = Object.entries(view.aliases || {}).map(([name, table]) => `<div class="alias-row"><strong>${esc(name)}</strong><code>${esc(table)}</code></div>`).join('');
    $('graph-section').hidden = !view.diagram;
    $('catalog-section').hidden = view.id !== 'catalog';
    if (view.id === 'catalog') {
      renderSerial++;
      renderCatalog();
      const moduleIndex = document.createElement('div');
      moduleIndex.className = 'module-list';
      moduleIndex.innerHTML = data.modules.map(module => `<button class="module-row" data-inspect-module="${module.id}">${icon(module.icon)}<span>${esc(module.name)}</span><small>${esc(module.category)}</small></button>`).join('');
      $('view-notes').appendChild(moduleIndex);
      icons();
      return Promise.resolve();
    }
    $('diagram-kind').textContent = view.diagram.trimStart().startsWith('sequenceDiagram') ? '时序关系 / 详见图中动作' : view.diagram.trimStart().startsWith('erDiagram') ? '数据对象关系 / 约束以说明为准' : view.diagram.trimStart().startsWith('stateDiagram') ? '状态与动作' : view.diagram.trimStart().startsWith('mindmap') ? '模块职责树' : '调用与数据流 / 以图中边标注为准';
    $('diagram-counter').textContent = `${String(data.views.filter(item => item.diagram).indexOf(view) + 1).padStart(2, '0')} / ${data.stats.diagrams}`;
    $('canvas-stamp').textContent = `${data.renderer} · ${data.date}`;
    icons();
    const serial = ++renderSerial;
    const diagram = smallScreen.matches && view.mobileDiagram ? view.mobileDiagram : view.diagram;
    renderedDiagram = diagram;
    const cacheKey = view.id + (diagram === view.mobileDiagram ? '_mobile' : '');
    $('graph-status').hidden = false;
    $('graph-status').textContent = '正在绘制关系图';
    viewport.dataset.renderState = 'loading';
    $('export-svg').disabled = true;
    renderQueue = renderQueue.catch(() => {}).then(async () => {
      try {
        let svg = cache.get(cacheKey);
        if (!svg) {
          svg = (await mermaid.render('diagram_' + cacheKey, diagram)).svg;
          cache.set(cacheKey, svg);
        }
        if (serial !== renderSerial) return;
        stage.innerHTML = svg;
        const element = stage.querySelector('svg');
        const box = element.viewBox.baseVal;
        diagramSize = { width: box.width, height: box.height };
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
        $('graph-status').textContent = '图表渲染失败。Mermaid 源码和模块证据仍可查看。';
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

  function moduleMarkup(module) {
    return `<div class="module-detail-heading"><h3>${esc(module.name)}</h3><span class="status-stack"><span class="tag">${esc(module.category)}</span>${freshnessBadge(module)}</span></div><p class="summary">${esc(module.summary)}</p>${module.staleReason ? `<p class="stale-note">${esc(module.staleReason)}</p>` : ''}<ul>${module.facts.map(fact => `<li>${esc(fact)}</li>`).join('')}</ul><div class="detail-grid"><div><div class="detail-heading">关联职责</div><div class="related-links">${module.links.map(id => byId(id) ? `<button class="text-link" data-inspect-module="${id}">${esc(byId(id).name)}</button>` : '').join('')}</div></div><div><div class="detail-heading">源码依据</div>${module.sources.map((source, index) => `<button class="evidence-link" data-evidence-module="${module.id}" data-source="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">L${source.line} · ${esc(source.path.split('/')[0])}</span></span></button>`).join('')}</div></div>`;
  }

  function sourceListMarkup(sources) {
    return sources.map((source, index) => `<button class="evidence-link" data-direct-source="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">L${source.line}</span></span></button>`).join('');
  }

  function showSourceCollection(title, description, sources) {
    dialog._directSources = sources;
    showDialog(title, `<p>${esc(description || '')}</p><div class="detail-heading">源码依据 · ${sources.length} 处</div>${sourceListMarkup(sources)}`);
  }

  function findingMarkup(finding) {
    const related = finding.modules.map(id => byId(id)).filter(Boolean);
    return `<div class="detail-status">${statusBadge(finding.kind, kindLabels[finding.kind])}${statusBadge(finding.status)}${freshnessBadge(finding)}</div>
      <p>${esc(finding.summary)}</p>
      ${finding.staleReason ? `<p class="stale-note">${esc(finding.staleReason)}</p>` : ''}
      ${finding.impact ? `<h4>影响</h4><p>${esc(finding.impact)}</p>` : ''}
      ${finding.nextCheck ? `<h4>最短验证路径</h4><p>${esc(finding.nextCheck)}</p>` : ''}
      ${related.length ? `<h4>关联模块</h4><div class="related-links">${related.map(module => `<button class="text-link" data-inspect-module="${module.id}">${esc(module.name)}</button>`).join('')}</div>` : ''}
      <h4>源码依据 · ${finding.sources.length} 处</h4>${finding.sources.map((source, index) => `<button class="evidence-link" data-finding-source="${finding.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">L${source.line}</span></span></button>`).join('')}`;
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
      ${item.sources.length ? `<h4>源码依据 · ${item.sources.length} 处</h4>${item.sources.map((source, index) => `<button class="evidence-link" data-coverage-source="${item.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">L${source.line}</span></span></button>`).join('')}` : ''}`);
  }

  function chainProgress(chain) {
    const total = chain.stages.length;
    const covered = chain.stages.filter(stage => stage.status === 'covered').length;
    const partial = chain.stages.filter(stage => stage.status === 'partial').length;
    return { total, covered, partial, percent: total ? Math.round(((covered + partial * 0.5) / total) * 100) : 0 };
  }

  function chainMarkup(chain) {
    const progress = chainProgress(chain);
    const views = chain.views.map(id => data.views.find(view => view.id === id)).filter(Boolean);
    return `<div class="detail-status">${statusBadge(chain.kind)}${freshnessBadge(chain)}<span class="chain-score">${progress.covered}/${progress.total} 阶段已确认</span></div>
      <p>${esc(chain.summary)}</p><div class="chain-route"><strong>触发</strong><span>${esc(chain.trigger)}</span><b>→</b><strong>结果</strong><span>${esc(chain.outcome)}</span></div>
      <h4>阶段证据</h4><div class="chain-stage-list">${chain.stages.map(stage => `<div class="chain-stage"><div><strong>${esc(stage.label)}</strong>${statusBadge(stage.status)}</div><p>${esc(stage.summary)}</p>${stage.nextCheck ? `<small>待确认：${esc(stage.nextCheck)}</small>` : ''}</div>`).join('')}</div>
      ${views.length ? `<h4>关联关系图</h4><div class="related-links">${views.map(view => `<button class="text-link" data-chain-view="${view.id}">${icon(view.icon)}${esc(view.title)}</button>`).join('')}</div>` : ''}
      <h4>链路源码依据 · ${chain.sources.length} 处</h4>${chain.sources.map((source, index) => `<button class="evidence-link" data-chain-source="${chain.id}" data-index="${index}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">L${source.line}</span></span></button>`).join('')}`;
  }

  function showChain(id) {
    const chain = data.chains.find(item => item.id === id);
    if (chain) showDialog(chain.title, chainMarkup(chain));
  }

  function renderChains() {
    const section = $('chain-section');
    section.hidden = !data.chains.length;
    $('chain-count').textContent = `${data.chains.length} 条链路`;
    $('chain-grid').innerHTML = data.chains.map(chain => {
      const progress = chainProgress(chain);
      return `<article class="chain-card" data-chain="${chain.id}"><div class="chain-card-head"><div><span class="eyebrow">${esc(chain.kind)}</span><h4>${esc(chain.title)}</h4></div>${freshnessBadge(chain)}</div><p>${esc(chain.summary)}</p><div class="chain-route"><span>${esc(chain.trigger)}</span><b>→</b><span>${esc(chain.outcome)}</span></div><div class="chain-progress"><span style="width:${progress.percent}%"></span></div><div class="chain-meta"><span>${progress.covered}/${progress.total} 阶段已确认</span><span>${chain.views.length} 张关联图</span><button class="text-link" data-chain="${chain.id}">查看链路</button></div></article>`;
    }).join('');
    icons();
  }

  function renderQuality() {
    const warnings = data.quality?.warnings || [];
    $('quality-section').hidden = !warnings.length;
    $('quality-list').innerHTML = warnings.map(warning => `<li>${esc(warning)}</li>`).join('');
  }

  function inspectModule(id, modal = false) {
    const module = byId(id);
    if (!module) return;
    selectedModule = id;
    stage.querySelectorAll('[data-module]').forEach(node => node.classList.toggle('is-selected', node.dataset.module === id));
    if (modal || current.id === 'catalog' || dialog.open) {
      showDialog('模块关系与依据', moduleMarkup(module));
    } else {
      $('module-detail').innerHTML = moduleMarkup(module);
      $('module-detail').hidden = false;
      $('module-list').querySelectorAll('[data-module]').forEach(button => button.setAttribute('aria-expanded', String(button.dataset.module === id)));
      icons();
      $('module-detail').scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }

  document.addEventListener('click', event => {
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
    const rows = data[catalogMode].filter(row => JSON.stringify(row).toLowerCase().includes(query));
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
    $('catalog-body').innerHTML = rows.map(row => {
      if (catalogMode === 'chains') { const progress = chainProgress(row); return `<tr><td><button class="text-link strong-link" data-chain="${row.id}">${esc(row.title)}</button><small>${esc(row.kind)}</small></td><td>${progress.covered}/${progress.total} 阶段已确认${freshnessBadge(row)}</td><td>${esc(row.summary)}<small>${esc(row.trigger)} → ${esc(row.outcome)}</small></td><td><button class="text-link" data-chain="${row.id}">${row.sources.length} 处依据</button></td></tr>`; }
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
    showDialog(table.title, `<p><code>${esc(name)}</code><br>${esc(table.kind)} · ${esc(table.description)}</p><div class="detail-heading">源码引用位置（引用不等于写入）</div>${table.sources.map((source, index) => `<button class="evidence-link" data-table-source="${esc(name)}" data-index="${index}">${icon('file-code-2')}<span>${esc(basename(source.path))}<span class="file-meta">L${source.line}</span></span></button>`).join('')}`);
  }

  $('module-search').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    $('view-nav').hidden = Boolean(query);
    $('search-results').hidden = !query;
    if (!query) return;
    const views = data.views.filter(view => [view.title, view.subtitle, view.group, ...(view.tags || [])].join(' ').toLowerCase().includes(query)).slice(0, 5);
    const chains = data.chains.filter(chain => JSON.stringify(chain).toLowerCase().includes(query)).slice(0, 5);
    const modules = data.modules.filter(module => JSON.stringify(module).toLowerCase().includes(query)).slice(0, 6);
    const findings = data.findings.filter(finding => JSON.stringify(finding).toLowerCase().includes(query)).slice(0, 5);
    const coverage = data.coverage.filter(item => JSON.stringify(item).toLowerCase().includes(query)).slice(0, 5);
    const routes = data.routes.filter(route => JSON.stringify(route).toLowerCase().includes(query)).slice(0, 5);
    const tables = data.tables.filter(table => [table.name, table.title, table.description].join(' ').toLowerCase().includes(query)).slice(0, 5);
    const flags = data.flags.filter(flag => JSON.stringify(flag).toLowerCase().includes(query)).slice(0, 5);
    const files = data.files.filter(file => file.name.toLowerCase().includes(query)).slice(0, 5);
    $('search-results').innerHTML = [
      chains.length ? '<div class="search-label">业务链路</div>' + chains.map(chain => `<button class="search-result" data-chain="${chain.id}">${esc(chain.title)}<small>${esc(chain.kind)}</small></button>`).join('') : '',
      views.length ? '<div class="search-label">视图</div>' + views.map(view => `<button class="search-result" data-search-view="${view.id}">${esc(view.title)}<small>${esc(view.group)}</small></button>`).join('') : '',
      modules.length ? '<div class="search-label">模块</div>' + modules.map(module => `<button class="search-result" data-search-module="${module.id}">${esc(module.name)}<small>${esc(module.category)}</small></button>`).join('') : '',
      findings.length ? '<div class="search-label">发现项</div>' + findings.map(finding => `<button class="search-result" data-finding="${finding.id}">${esc(finding.title)}<small>${esc(kindLabels[finding.kind])} · ${esc(statusLabels[finding.status])}</small></button>`).join('') : '',
      coverage.length ? '<div class="search-label">覆盖矩阵</div>' + coverage.map(item => `<button class="search-result" data-coverage="${item.id}">${esc(item.area)}<small>${esc(statusLabels[item.status])}</small></button>`).join('') : '',
      routes.length ? '<div class="search-label">接口 / 事件</div>' + routes.map(route => `<button class="search-result" data-route="${esc(route.prefix)}">${esc(route.prefix)}<small>${esc(route.name)}</small></button>`).join('') : '',
      tables.length ? '<div class="search-label">数据对象</div>' + tables.map(table => `<button class="search-result" data-table="${esc(table.name)}">${esc(table.title)}<small>${esc(table.name)}</small></button>`).join('') : '',
      flags.length ? '<div class="search-label">配置项</div>' + flags.map(flag => `<button class="search-result" data-flag="${esc(flag.name)}">${esc(flag.name)}<small>${esc(typeof flag.value === 'object' ? JSON.stringify(flag.value) : flag.value)}</small></button>`).join('') : '',
      files.length ? '<div class="search-label">代码文件</div>' + files.map(file => `<a class="search-result" target="_blank" rel="noopener" href="${fileUrl(file.path)}">${esc(file.name)}<small>${esc(file.group)}</small></a>`).join('') : ''
    ].join('') || '<div class="search-label">没有匹配的分析内容</div>';
  });

  document.addEventListener('click', event => {
    const chain = event.target.closest('[data-chain]');
    if (chain) { closeNav(); showChain(chain.dataset.chain); return; }
    const chainView = event.target.closest('[data-chain-view]');
    if (chainView) { dialog.close(); navigate(chainView.dataset.chainView); return; }
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
      $('catalog-search').value = '';
      document.querySelectorAll('[data-catalog]').forEach(button => button.setAttribute('aria-selected', String(button === catalogTab)));
      renderCatalog();
    }
    if (event.target.closest('#copy-mermaid')) copySource();
    if (event.target.closest('#download-mermaid')) download(`${current.title}.mmd`, sourceForCopy, 'text/plain;charset=utf-8');
  });

  $('catalog-search').addEventListener('input', renderCatalog);
  function showEvidenceList(row, kind) {
    const index = data[kind].indexOf(row);
    showDialog('源码依据 · ' + (row.name || row.prefix), `<p>${esc(row.description || '')}</p>${row.sources.map((source, sourceIndex) => `<button class="evidence-link" data-index-kind="${kind}" data-row="${index}" data-index-source="${sourceIndex}">${icon('file-code-2')}<span>${esc(source.path)}<span class="file-meta">L${source.line}</span></span></button>`).join('')}`);
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
  $('close-dialog').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
  $('open-nav').addEventListener('click', () => { $('sidebar').classList.add('is-open'); $('nav-backdrop').hidden = false; });
  $('close-nav').addEventListener('click', closeNav);
  $('nav-backdrop').addEventListener('click', closeNav);
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1), false));
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
  }
  $('open-findings').disabled = !data.findings.length;
  $('open-coverage').disabled = !data.coverage.length;
  $('open-chains').disabled = !data.chains.length;
  $('footer-baseline').textContent = data.repositories.map(repo => repo.name + ' ' + repo.commit).join(' / ');
  $('footer-boundary').textContent = data.project.boundary;
  renderChains();
  renderQuality();
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
    navigate('catalog');
    document.querySelectorAll('[data-catalog]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.catalog === kind)));
    renderCatalog();
  }
  $('open-findings').addEventListener('click', () => openCatalog('findings'));
  $('open-coverage').addEventListener('click', () => openCatalog('coverage'));
  $('open-chains').addEventListener('click', () => openCatalog('chains'));
  nav();
  icons();
  window.repoAtlas = { navigate, data, fit, get currentView() { return current?.id; }, get camera() { return { ...camera }; }, get selectedModule() { return selectedModule; } };
  navigate(location.hash.slice(1) || data.views[0].id, false);
})();
