// Dependency-free evaluator for the keywords used by our bundled schema.
// This is deliberately not a general-purpose JSON Schema implementation.
// Unsupported keywords and references fail at startup, never silently pass.
import { readFileSync } from 'node:fs';

export const manifestSchema = JSON.parse(readFileSync(new URL('../schemas/atlas.schema.json', import.meta.url), 'utf8'));
export const pointer = (base, key) => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keywords = new Set(['$schema', '$defs', '$ref', 'title', 'description', 'default', 'examples', 'type', 'required', 'properties', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'allOf', 'anyOf', 'if', 'then', 'else', 'not', 'const', 'enum', 'pattern', 'minLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'items']);
function reference(ref) {
  if (!ref.startsWith('#/$defs/') || !Object.hasOwn(manifestSchema.$defs, ref.slice(8))) throw new Error('Unsupported bundled schema reference');
  return manifestSchema.$defs[ref.slice(8)];
}
function checkSchema(schema) {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported bundled schema keyword: ${key}`);
  if (schema.$ref) reference(schema.$ref);
  if (schema.pattern) new RegExp(schema.pattern);
  for (const key of ['$defs', 'properties']) for (const child of Object.values(schema[key] || {})) checkSchema(child);
  for (const key of ['allOf', 'anyOf']) for (const child of schema[key] || []) checkSchema(child);
  for (const key of ['if', 'then', 'else', 'not', 'items', 'additionalProperties', 'propertyNames']) if (schema[key] !== undefined) checkSchema(schema[key]);
  if (schema.unevaluatedProperties !== undefined && schema.unevaluatedProperties !== false) throw new Error('Only closed unevaluatedProperties is supported');
}
checkSchema(manifestSchema);

export function validateSchema(value) {
  function visit(data, schema, path, errors) {
    const evaluated = new Set();
    const error = (code, message, at = path) => errors.push({ severity: 'error', code: `schema.${code}`, path: at, message });
    const merge = result => { for (const key of result) evaluated.add(key); };
    if (schema === true) return evaluated;
    if (schema === false) { error('forbidden', '此处不允许提供值。'); return evaluated; }
    if (schema.$ref) merge(visit(data, reference(schema.$ref), path, errors));
    if (schema.type) {
      const valid = schema.type === 'object' ? object(data) : schema.type === 'array' ? Array.isArray(data) : schema.type === 'integer' ? Number.isInteger(data) : typeof data === schema.type;
      if (!valid) { error('type', `应为 ${schema.type}。`); return evaluated; }
    }
    if (schema.enum && !schema.enum.includes(data)) error('enum', `允许值：${schema.enum.join(', ')}。`);
    if (Object.hasOwn(schema, 'const') && data !== schema.const) error('const', '值不符合固定值约束。');
    if (typeof data === 'string') {
      if (schema.pattern && !new RegExp(schema.pattern).test(data)) error('pattern', '字符串不符合格式约束。');
      if (schema.minLength !== undefined && [...data].length < schema.minLength) error('minLength', `至少需要 ${schema.minLength} 个字符。`);
    }
    if (typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) error('minimum', `数值不得小于 ${schema.minimum}。`);
      if (schema.maximum !== undefined && data > schema.maximum) error('maximum', `数值不得大于 ${schema.maximum}。`);
    }
    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) error('minItems', `至少需要 ${schema.minItems} 项。`);
      if (schema.maxItems !== undefined && data.length > schema.maxItems) error('maxItems', `最多允许 ${schema.maxItems} 项。`);
      if (schema.items !== undefined) data.forEach((item, index) => visit(item, schema.items, pointer(path, index), errors));
    }
    if (object(data)) {
      for (const key of schema.required || []) if (!Object.hasOwn(data, key)) error('required', '缺少必填字段。', pointer(path, key));
      for (const [key, item] of Object.entries(data)) {
        if (schema.propertyNames) visit(key, schema.propertyNames, pointer(path, key), errors);
        if (Object.hasOwn(schema.properties || {}, key)) {
          evaluated.add(key); visit(item, schema.properties[key], pointer(path, key), errors);
        } else if (schema.additionalProperties !== undefined) {
          evaluated.add(key);
          if (schema.additionalProperties === false) error('unknownProperty', '未知字段；请检查拼写并移除未支持的字段。', pointer(path, key));
          else visit(item, schema.additionalProperties, pointer(path, key), errors);
        }
      }
    }
    for (const child of schema.allOf || []) merge(visit(data, child, path, errors));
    if (schema.anyOf) {
      let matched = false;
      for (const child of schema.anyOf) {
        const probe = []; const result = visit(data, child, path, probe);
        if (!probe.length) { matched = true; merge(result); }
      }
      if (!matched) error('anyOf', '至少需要一个视图或一条业务链路。');
    }
    if (schema.if) {
      const probe = []; const result = visit(data, schema.if, path, probe);
      if (!probe.length) merge(result);
      const branch = probe.length ? schema.else : schema.then;
      if (branch !== undefined) merge(visit(data, branch, path, errors));
    }
    if (schema.not) {
      const probe = []; visit(data, schema.not, path, probe);
      if (!probe.length) error('reserved', '此值为生成器保留值。');
    }
    if (object(data) && schema.unevaluatedProperties === false) {
      for (const key of Object.keys(data)) if (!evaluated.has(key)) error('unknownProperty', '未知字段；请检查拼写并移除未支持的字段。', pointer(path, key));
    }
    return evaluated;
  }
  const errors = [];
  visit(value, manifestSchema, '', errors);
  return errors;
}
