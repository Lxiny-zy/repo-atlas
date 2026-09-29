import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const hashBytes = value => createHash('sha256').update(value).digest('hex');
export const hashText = value => hashBytes(Buffer.from(value, 'utf8'));
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function normalizeSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('source must be an object');
  for (const key of ['path', 'match']) if (typeof source[key] !== 'string' || !source[key].trim()) throw new Error(`source.${key} must be a nonempty string`);
  if (source.id != null && (typeof source.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(source.id))) throw new Error('Invalid source.id');
  const length = source.length ?? 8;
  if (!Number.isInteger(length) || length < 1 || length > 60) throw new Error('Evidence length must be 1..60 lines');
  if (source.occurrence != null && (!Number.isInteger(source.occurrence) || source.occurrence < 1)) throw new Error('Invalid evidence occurrence');
  const redact = source.redact ?? [];
  if (!Array.isArray(redact) || redact.some(value => typeof value !== 'string' || !value.length)) throw new Error('redact must be an array of nonempty strings');
  return { ...source, length, occurrence: source.occurrence ?? null, redact };
}

export const redactionValues = sources => [...new Set(sources.flatMap(source => normalizeSource(source).redact))].sort((a, b) => b.length - a.length || a.localeCompare(b));
export const redactionHash = values => hashText(JSON.stringify([...new Set(values)].sort()));
export function redactText(text, values, replacement = '[REDACTED]') {
  for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) text = text.split(value).join(replacement);
  return text;
}
export function redactValue(value, values) {
  if (typeof value === 'string') return redactText(value, values);
  if (Array.isArray(value)) return value.map(item => redactValue(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, values), redactValue(item, values)]));
  return value;
}

export function parseSourceText(text) { return { lines: text.split(/\r?\n/), matches: new Map() }; }
export function resolveEvidence(document, spec) {
  const source = normalizeSource(spec);
  if (typeof document === 'string') document = parseSourceText(document);
  if (!document.matches.has(source.match)) {
    const found = [];
    document.lines.forEach((line, index) => { if (line.includes(source.match)) found.push(index); });
    document.matches.set(source.match, found);
  }
  const matches = document.matches.get(source.match);
  const state = !matches.length ? 'missing' : matches.length > 1 && source.occurrence == null ? 'ambiguous' : matches[(source.occurrence ?? 1) - 1] == null ? 'invalid' : 'resolved';
  const reasons = { missing: 'Missing evidence anchor', ambiguous: 'Ambiguous evidence anchor; specify occurrence or use a unique anchor', invalid: 'Invalid evidence occurrence' };
  const start = state === 'resolved' ? matches[(source.occurrence ?? 1) - 1] : null;
  const raw = start == null ? null : document.lines.slice(start, start + source.length).join('\n');
  return { state, resolved: state === 'resolved', matches: matches.length, line: start == null ? null : start + 1, text: raw == null ? null : redactText(raw, source.redact), excerptSha256: raw == null ? null : hashText(raw), reason: reasons[state] || null };
}

// Cache in-flight reads and parsed lines once per evidence file.
export function sourceReader(resolvePath) {
  const cache = new Map();
  return async path => {
    const full = await resolvePath(path);
    if (!cache.has(full)) cache.set(full, readFile(full).then(bytes => ({ full, sha256: hashBytes(bytes), text: bytes.toString('utf8'), document: parseSourceText(bytes.toString('utf8')) })));
    return cache.get(full);
  };
}
