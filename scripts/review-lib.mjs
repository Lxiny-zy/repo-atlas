import { readFile } from 'node:fs/promises';
import { assertOutputInside, createSnapshot, analysisManifestHash, hashText, snapshotHash, buildSummaryIndex } from './snapshot-lib.mjs';
import { collectSourceRows } from './snapshot-lib.mjs';
import { redactValue, redactionValues } from './evidence-lib.mjs';

export function entityRows(manifest) {
  const rows = [];
  for (const [type, collection, field] of [['module', 'modules', 'id'], ['view', 'views', 'id'], ['chain', 'chains', 'id'], ['finding', 'findings', 'id'], ['coverage', 'coverage', 'id'], ['table', 'tables', 'name'], ['route', 'routes', 'prefix'], ['flag', 'flags', 'name']]) {
    for (const row of manifest[collection] || []) {
      rows.push({ key: `${type}:${row[field]}`, row });
      if (type === 'chain') for (const stage of row.stages || []) rows.push({ key: `chain-stage:${row.id}/${stage.id}`, row: stage });
    }
  }
  return rows;
}

// Review may follow semantic edits to a candidate. Its original file inventory
// must still match delta, while the edited candidate is bound by a fresh digest.
export async function reviewState(bundle) {
  const update = bundle.manifest.update;
  if (update?.mode !== 'incremental-candidate' || !update.deltaPath) throw new Error('Review requires a refresh candidate with deltaPath');
  const deltaPath = assertOutputInside(bundle.workspace, update.deltaPath);
  const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
  const baselinePath = assertOutputInside(bundle.workspace, update.baseSnapshot || delta.from?.path);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const current = await createSnapshot(bundle, null, { allowMissingSources: true });
  if (delta.schemaVersion !== 2 || delta.from?.snapshotSha256 !== snapshotHash(baseline) || current.workspaceSha256 !== delta.workspaceSha256) throw new Error('Review baseline/workspace mismatch');
  if (current.inventorySha256 !== delta.to.inventorySha256) throw new Error('Source drift since delta; regenerate delta and candidate');
  return { current, delta, baseline, deltaPath, baselinePath };
}

export function reviewTasks(bundle, state) {
  const tasks = new Map();
  const add = (key, kind, detail) => tasks.set(key, { key, kind, detail, fingerprint: hashText(JSON.stringify(detail)), decision: 'pending', note: '' });
  const summaries = buildSummaryIndex(bundle.manifest);
  // All semantic entities are reviewed when accepting a complete delivery.
  for (const [entity, summary] of Object.entries(summaries)) add(`entity:${entity}`, 'entity', { entity, ...summary });
  for (const [key, row] of Object.entries(state.current.evidence)) if (!row.resolved) add(`evidence:${key}`, 'unresolved-evidence', { key, path: row.path, reason: row.staleReason });
  for (const row of bundle.manifest.update?.staleEvidence || []) if (!state.current.evidence[row.key]) add(`removed:${row.key}`, 'removed-evidence', row);
  for (const row of bundle.manifest.update?.unmappedChanges || []) add(`file:${row.path}`, 'unmapped-change', row);
  add('scope', 'scope', { scope: bundle.manifest.project?.scope, boundary: bundle.manifest.project?.boundary, reasons: state.delta.summary?.fullReanalysisReasons || [] });
  return redactValue([...tasks.values()], redactionValues(collectSourceRows(bundle.manifest)));
}

export function reviewBinding(bundle, state) {
  return { candidateSha256: hashText(bundle.raw), analysisManifestSha256: analysisManifestHash(bundle.manifest), workspaceSha256: state.current.workspaceSha256, inventorySha256: state.current.inventorySha256, baselineSha256: snapshotHash(state.baseline), deltaSha256: hashText(JSON.stringify(state.delta)) };
}

export function validateReview(bundle, state, review) {
  if (review.schemaVersion !== 1 || review.purpose !== 'atlas-review') throw new Error('Invalid review document');
  const binding = reviewBinding(bundle, state);
  for (const [key, value] of Object.entries(binding)) if (review.binding?.[key] !== value) throw new Error(`Review drift: ${key}; prepare a new review`);
  if (typeof review.reviewer !== 'string' || !review.reviewer.trim()) throw new Error('Review requires reviewer');
  if (typeof review.reviewedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(review.reviewedAt) || !Number.isFinite(Date.parse(review.reviewedAt))) throw new Error('Review requires an ISO reviewedAt with timezone');
  const tasks = reviewTasks(bundle, state);
  if (!Array.isArray(review.items) || review.items.length !== tasks.length || new Set(review.items.map(item => item.key)).size !== tasks.length) throw new Error('Review task set mismatch');
  for (const task of tasks) {
    const item = review.items.find(item => item.key === task.key);
    if (item?.fingerprint !== task.fingerprint || item.kind !== task.kind || hashText(JSON.stringify(item.detail)) !== hashText(JSON.stringify(task.detail))) throw new Error(`Review task changed: ${task.key}`);
    if (item.decision !== 'approved' || typeof item.note !== 'string' || !item.note.trim()) throw new Error(`Review incomplete: ${task.key}; an approved decision and note are required`);
    if (task.kind === 'unresolved-evidence') throw new Error(`Unresolved evidence cannot be accepted: ${task.key}`);
  }
  return tasks;
}
