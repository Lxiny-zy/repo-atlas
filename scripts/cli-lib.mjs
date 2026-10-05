// Shared, dependency-free CLI contract. Parsing never reads or writes files.
export class UsageError extends Error {}

export function parseArgs(argv, { boolean = [], value = [], required = [], min = 1, max = min } = {}) {
  const booleans = new Set(['help', ...boolean]);
  const values = new Set(value);
  const options = Object.assign(Object.create(null), { _: [] });
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options._.push(...argv.slice(index + 1)); break; }
    if (arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('-')) { options._.push(arg); continue; }
    if (!arg.startsWith('--')) throw new UsageError('Unknown short option; use --help');
    const separator = arg.indexOf('=');
    const key = arg.slice(2, separator < 0 ? undefined : separator);
    if (!booleans.has(key) && !values.has(key)) throw new UsageError('Unknown option; use --help');
    if (Object.hasOwn(options, key)) throw new UsageError(`Duplicate --${key}`);
    if (booleans.has(key)) {
      if (separator >= 0) throw new UsageError(`--${key} does not take a value`);
      options[key] = true;
    } else {
      const next = separator >= 0 ? arg.slice(separator + 1) : argv[index + 1];
      if (!next || (separator < 0 && next.startsWith('--'))) throw new UsageError(`--${key} requires a value`);
      options[key] = next;
      if (separator < 0) index++;
    }
  }
  if (!options.help) {
    if (options._.length < min || options._.length > max) throw new UsageError('Unexpected number of positional arguments');
    for (const key of required) if (!Object.hasOwn(options, key)) throw new UsageError(`--${key} is required`);
  }
  return options;
}

export function parseOptions(argv, specification) {
  try {
    const options = parseArgs(argv, specification);
    if (options.help) { console.log(specification.usage); process.exit(0); }
    return options;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${specification.usage}`);
    process.exit(2);
  }
}
