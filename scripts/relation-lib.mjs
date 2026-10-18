// Reader diagrams show declared data delivery only. Keep dependency evidence in the manifest.
const label = value => String(value).replace(/[#&"<>\r\n]/g, char => ({ '#': '#35;', '&': '#38;', '"': '#34;', '<': '#60;', '>': '#62;', '\r': ' ', '\n': ' ' }[char]));

export function relationDiagram(modules, relations, direction = 'LR') {
  const lines = [`flowchart ${direction}`];
  for (const module of modules) lines.push(`atlas_${module.id}["${label(module.name)}"]`);
  relations.filter(relation => relation.kind === 'data_flow').forEach((relation, index) => {
    lines.push(`atlas_${relation.from} -->|"${label(relation.label)}"| atlas_${relation.to}`);
    lines.push(`linkStyle ${index} stroke:#238577,stroke-width:2px`);
  });
  lines.push(`classDef architecture fill:#f2f7f5,stroke:#91b4a8,color:#254f43,stroke-width:1.5px`);
  for (const module of modules) lines.push(`class atlas_${module.id} architecture`);
  return lines.join('\n');
}

export function relationVariants(view, modules, relations) {
  const rows = relations.filter(row => row.kind === 'data_flow' && view.relations.includes(row.id));
  const nodes = modules.filter(row => view.modules.includes(row.id));
  // The bundled Mermaid 10 renderer numbers parallel edges per ordered pair.
  // Bind each transfer explicitly, including multiple payloads between the same modules.
  const occurrences = new Map();
  const edgeBindings = rows.map(row => {
    const pair = JSON.stringify([row.from, row.to]);
    const occurrence = occurrences.get(pair) || 0;
    occurrences.set(pair, occurrence + 1);
    return { edge: `L-atlas_${row.from}-atlas_${row.to}-${occurrence}`, relation: row.id };
  });
  return {
    variants: { data_flow: { diagram: relationDiagram(nodes, rows), mobileDiagram: relationDiagram(nodes, rows, 'TB'), relations: rows.map(row => row.id), edgeBindings } },
    defaultMode: 'data_flow'
  };
}

export function chainDiagram(chain, direction = 'LR') {
  const lines = [`flowchart ${direction}`];
  for (const stage of chain.stages || []) lines.push(`atlas_stage_${stage.id}["${label(stage.label)}"]`);
  for (const transition of chain.transitions || []) {
    const edgeLabel = transition.guard ? `${transition.label}: ${transition.guard}` : transition.label;
    const status = transition.status === 'unverified' ? ' [待验证]' : transition.status === 'inferred' ? ' [推断]' : '';
    lines.push(`atlas_stage_${transition.from} ${transition.status === 'confirmed' ? '-->' : '-.->'}|"${label(edgeLabel + status)}"| atlas_stage_${transition.to}`);
  }
  lines.push('classDef stage fill:#f2f7f5,stroke:#91b4a8,color:#254f43,stroke-width:1.5px');
  for (const stage of chain.stages || []) lines.push(`class atlas_stage_${stage.id} stage`);
  return lines.join('\n');
}
