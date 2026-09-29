// Bound the serialized bundle, including metadata. All clipping is explicit.
export function budgetContext(context, maxBytes) {
  context.budget = { maxBytes, truncated: false, omitted: {} };
  const bytes = () => Buffer.byteLength(JSON.stringify(context, null, 2) + '\n');
  const fits = () => bytes() <= maxBytes;
  if (fits()) return context;
  context.budget.truncated = true;
  for (const file of [...context.changedFiles].reverse()) {
    if (file.diff) { file.diff = null; file.diffTruncated = true; file.diffUnavailableReason = 'context-byte-budget'; }
    if (fits()) return context;
  }
  const arrays = [
    ['evidence', context.evidence], ['entities', context.entities],
    ...Object.entries(context.relationships).map(([key, value]) => ['relationships.' + key, value]),
    ['changedFiles', context.changedFiles], ['unmappedChanges', context.unmappedChanges]
  ];
  for (const [key, items] of arrays) {
    while (items.length && !fits()) {
      // Drop a bounded chunk to avoid quadratic serialization on large bundles.
      const count = Math.max(1, Math.ceil(items.length / 4));
      items.splice(-count);
      context.budget.omitted[key] = (context.budget.omitted[key] || 0) + count;
    }
    if (fits()) return context;
  }
  throw new Error('Context metadata exceeds --max-bytes; increase the budget');
}
