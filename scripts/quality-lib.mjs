// Authoring quality checks that can be reviewed before acceptance. These
// checks describe structural uncertainty; they do not claim that runtime
// behavior is proven by the manifest alone.
export function reviewQualityWarnings(manifest) {
  const warnings = [];
  const views = manifest.views || [];
  const chains = manifest.chains || [];
  const modules = manifest.modules || [];
  const add = (code, entity, message) => warnings.push({ code, entity, message });
  for (const view of views) {
    const sequence = view.diagram?.trimStart().startsWith('sequenceDiagram');
    if ((sequence || ['sequence', 'narrative'].includes(view.kind)) && !chains.some(chain => chain.views?.includes(view.id)) && !view.notes?.length) {
      add('missing-narrative', `view:${view.id}`, `流程“${view.title}”缺少文字说明；请补充业务阶段或视图备注。`);
    }
  }
  if (modules.length >= 8 && !chains.length) add('missing-chains', 'project', '模块数量较多但没有登记业务链路；复杂项目容易退化为一张总览图。');
  for (const chain of chains) {
    const stages = chain.stages || [];
    if (!stages.some(stage => ['entry', 'authorization', 'validation', 'custom'].includes(stage.kind || 'custom'))) add('missing-entry', `chain:${chain.id}`, `“${chain.title}”尚未登记入口或前置条件，还需要确认由谁发起、需要满足哪些条件。`);
    if (!stages.some(stage => ['outcome', 'recovery', 'custom'].includes(stage.kind || 'custom'))) add('missing-outcome', `chain:${chain.id}`, `“${chain.title}”尚未登记业务结果或异常恢复，后续处理还需要补充确认。`);
    const linkedViews = views.filter(view => chain.views?.includes(view.id));
    const linkedModules = new Set(linkedViews.flatMap(view => view.modules || []));
    for (const id of chain.modules || []) if (linkedViews.length && !linkedModules.has(id)) add('module-outside-views', `chain:${chain.id}/module:${id}`, `“${chain.title}”涉及的“${modules.find(module => module.id === id)?.name || '相关环节'}”尚未出现在配套关系图中。`);
    const transitions = chain.transitions || [];
    if (!transitions.length) continue;
    const stageIds = new Set(stages.map(stage => stage.id));
    const outgoing = new Map(stages.map(stage => [stage.id, []]));
    const incoming = new Map(stages.map(stage => [stage.id, 0]));
    for (const transition of transitions) {
      if (!stageIds.has(transition.from) || !stageIds.has(transition.to)) continue;
      outgoing.get(transition.from).push(transition.to);
      incoming.set(transition.to, (incoming.get(transition.to) || 0) + 1);
    }
    const entries = stages.filter(stage => stage.kind === 'entry');
    const roots = (entries.length ? entries : stages.filter(stage => incoming.get(stage.id) === 0)).map(stage => stage.id);
    const reachable = new Set(roots), queue = [...roots];
    for (let index = 0; index < queue.length; index++) for (const next of outgoing.get(queue[index]) || []) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    for (const stage of stages) if (!reachable.has(stage.id)) add('unreachable-stage', `chain-stage:${chain.id}/${stage.id}`, `“${chain.title}”的阶段“${stage.label}”在 transitions 中不可达，需要确认入口或转移。`);
    for (const stage of stages) if (!(outgoing.get(stage.id) || []).length && !['outcome', 'recovery'].includes(stage.kind)) add('untyped-terminal', `chain-stage:${chain.id}/${stage.id}`, `“${chain.title}”的终止阶段“${stage.label}”未标记为 outcome 或 recovery。`);
  }
  return warnings;
}
