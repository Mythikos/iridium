/** Conservative additive-wire comparison. Unknown validation changes require an API-version review. */
export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error('Expected a wire-contract object.');
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function dereference(value: unknown, root: unknown): Record<string, unknown> {
  let schema = object(value);
  const seen = new Set<string>();
  while (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref'];
    if (!ref.startsWith('#/') || seen.has(ref))
      throw new Error(`Unsupported or cyclic bare schema reference: ${ref}`);
    seen.add(ref);
    let target = root;
    for (const segment of ref.slice(2).split('/'))
      target = object(target)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    schema = object(target);
  }
  return schema;
}

const ANNOTATIONS = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'title',
  'description',
  'examples',
  'example',
  'deprecated',
  'default',
  'readOnly',
  'writeOnly',
]);
const HANDLED = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'items',
  'additionalProperties',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
]);
const LOWER = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'] as const;
const UPPER = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'] as const;

/** Responses preserve promised fields; requests cannot start requiring fields older callers omitted. */
export function schemaChanges(
  previous: unknown,
  current: unknown,
  direction: 'request' | 'response',
  previousRoot: unknown = previous,
  currentRoot: unknown = current,
  path = '$',
  ancestors: readonly (readonly [unknown, unknown])[] = [],
): string[] {
  if (previous === false) return [];
  if (current === true) return direction === 'request' ? [] : [`${path}: lost the response schema`];
  if (current === undefined || current === false) return [`${path}: removed schema`];
  const before =
    previous === true || previous === undefined ? {} : dereference(previous, previousRoot);
  const after = dereference(current, currentRoot);
  if (ancestors.some(([left, right]) => left === before && right === after)) return [];
  const nextAncestors = [...ancestors, [before, after] as const];
  const findings: string[] = [];
  const issue = (text: string): void => {
    findings.push(`${path}: ${text}`);
  };
  const visit = (left: unknown, right: unknown, child: string): void => {
    findings.push(
      ...schemaChanges(
        left,
        right,
        direction,
        previousRoot,
        currentRoot,
        `${path}.${child}`,
        nextAncestors,
      ),
    );
  };
  const oldTypes = typeof before['type'] === 'string' ? [before['type']] : list(before['type']);
  const newTypes = typeof after['type'] === 'string' ? [after['type']] : list(after['type']);
  if (
    oldTypes.some(
      (type) => !newTypes.includes(type) && !(type === 'integer' && newTypes.includes('number')),
    )
  )
    issue('removed or changed a type');
  if (
    oldTypes.length === 0 &&
    newTypes.length > 0 &&
    !['anyOf', 'oneOf', 'allOf'].some((key) => key in before)
  )
    issue('introduced a type restriction');
  for (const key of LOWER)
    if (
      typeof after[key] === 'number' &&
      (typeof before[key] !== 'number' || after[key] > before[key])
    )
      issue(`tightened ${key}`);
  for (const key of UPPER)
    if (
      typeof after[key] === 'number' &&
      (typeof before[key] !== 'number' || after[key] < before[key])
    )
      issue(`tightened ${key}`);
  const oldValues =
    'const' in before ? [before['const']] : 'enum' in before ? list(before['enum']) : undefined;
  const newValues =
    'const' in after ? [after['const']] : 'enum' in after ? list(after['enum']) : undefined;
  if (
    newValues !== undefined &&
    (oldValues === undefined ||
      oldValues.some((value) => !newValues.some((other) => equal(value, other))))
  )
    issue('restricted enum or const');
  if (oldValues !== undefined && newValues === undefined && direction === 'response')
    issue('removed the enum or const contract');
  const oldProperties = before['properties'] === undefined ? {} : object(before['properties']);
  const newProperties = after['properties'] === undefined ? {} : object(after['properties']);
  for (const [key, value] of Object.entries(oldProperties)) {
    if (!(key in newProperties)) issue(`removed field ${key}`);
    else visit(value, newProperties[key], `properties.${key}`);
  }
  const oldRequired = list(before['required']);
  const newRequired = list(after['required']);
  if (direction === 'request' && newRequired.some((key) => !oldRequired.includes(key)))
    issue('introduced a required request field');
  if (direction === 'response' && oldRequired.some((key) => !newRequired.includes(key)))
    issue('removed a required response field');
  if ('items' in before) visit(before['items'], after['items'], 'items');
  else if ('items' in after) visit({}, after['items'], 'items');
  if (
    direction === 'request' &&
    before['additionalProperties'] !== false &&
    after['additionalProperties'] === false
  )
    issue('disallowed additional request fields');
  if (typeof before['additionalProperties'] === 'object')
    visit(before['additionalProperties'], after['additionalProperties'], 'additionalProperties');
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (!(key in before)) {
      if (key in after) issue(`introduced ${key} constraint`);
      continue;
    }
    const candidates = list(after[key]);
    for (const [index, variant] of list(before[key]).entries()) {
      if (
        !candidates.some(
          (candidate) =>
            schemaChanges(
              variant,
              candidate,
              direction,
              previousRoot,
              currentRoot,
              path,
              nextAncestors,
            ).length === 0,
        )
      )
        issue(`removed or narrowed ${key}[${index}]`);
    }
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ANNOTATIONS.has(key) || HANDLED.has(key) || key.startsWith('x-')) continue;
    if (!equal(before[key], after[key])) issue(`changed validation keyword ${key}`);
  }
  return findings;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
/** All pre-existing operation/status/media/schema edges remain checked, including path parameters. */
export function openApiChanges(previous: unknown, current: unknown): string[] {
  const oldRoot = object(previous);
  const newRoot = object(current);
  const oldPaths = object(oldRoot['paths']);
  const newPaths = object(newRoot['paths']);
  const findings: string[] = [];
  const content = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    direction: 'request' | 'response',
    path: string,
  ): void => {
    for (const [media, shape] of Object.entries(
      left['content'] === undefined ? {} : object(left['content']),
    )) {
      const replacement =
        right['content'] === undefined ? undefined : object(right['content'])[media];
      if (replacement === undefined) findings.push(`${path}: removed content type ${media}`);
      else
        findings.push(
          ...schemaChanges(
            object(shape)['schema'],
            object(replacement)['schema'],
            direction,
            oldRoot,
            newRoot,
            `${path}.${media}`,
          ),
        );
    }
  };
  for (const [path, item] of Object.entries(oldPaths)) {
    if (!(path in newPaths)) {
      findings.push(`${path}: removed path`);
      continue;
    }
    const oldItem = object(item);
    const newItem = object(newPaths[path]);
    for (const method of METHODS) {
      if (!(method in oldItem)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      if (!(method in newItem)) {
        findings.push(`${label}: removed operation`);
        continue;
      }
      const before = object(oldItem[method]);
      const after = object(newItem[method]);
      if (before['operationId'] !== after['operationId'])
        findings.push(`${label}: changed operationId`);
      const parameters = [...list(oldItem['parameters']), ...list(before['parameters'])].map(
        (value) => dereference(value, oldRoot),
      );
      const currentParameters = [...list(newItem['parameters']), ...list(after['parameters'])].map(
        (value) => dereference(value, newRoot),
      );
      for (const parameter of parameters) {
        const replacement = currentParameters.find(
          (value) => value['name'] === parameter['name'] && value['in'] === parameter['in'],
        );
        if (replacement === undefined)
          findings.push(`${label}: removed parameter ${String(parameter['name'])}`);
        else {
          if (parameter['required'] !== true && replacement['required'] === true)
            findings.push(`${label}: required parameter ${String(parameter['name'])}`);
          findings.push(
            ...schemaChanges(
              parameter['schema'],
              replacement['schema'],
              'request',
              oldRoot,
              newRoot,
              `${label}.parameters.${String(parameter['name'])}`,
            ),
          );
        }
      }
      for (const parameter of currentParameters)
        if (
          parameter['required'] === true &&
          !parameters.some(
            (old) => old['name'] === parameter['name'] && old['in'] === parameter['in'],
          )
        )
          findings.push(`${label}: added required parameter ${String(parameter['name'])}`);
      if (before['requestBody'] !== undefined) {
        if (after['requestBody'] === undefined) findings.push(`${label}: removed request body`);
        else {
          const oldBody = dereference(before['requestBody'], oldRoot);
          const newBody = dereference(after['requestBody'], newRoot);
          if (oldBody['required'] !== true && newBody['required'] === true)
            findings.push(`${label}: required request body`);
          content(oldBody, newBody, 'request', `${label}.body`);
        }
      } else if (
        after['requestBody'] !== undefined &&
        dereference(after['requestBody'], newRoot)['required'] === true
      )
        findings.push(`${label}: added required body`);
      const oldResponses = object(before['responses']);
      const newResponses = object(after['responses']);
      for (const [status, response] of Object.entries(oldResponses)) {
        if (!(status in newResponses)) {
          findings.push(`${label}: removed response ${status}`);
          continue;
        }
        const oldResponse = dereference(response, oldRoot);
        const newResponse = dereference(newResponses[status], newRoot);
        content(oldResponse, newResponse, 'response', `${label}.${status}`);
        for (const [header, value] of Object.entries(
          oldResponse['headers'] === undefined ? {} : object(oldResponse['headers']),
        )) {
          const replacement =
            newResponse['headers'] === undefined
              ? undefined
              : object(newResponse['headers'])[header];
          if (replacement === undefined)
            findings.push(`${label}.${status}: removed header ${header}`);
          else
            findings.push(
              ...schemaChanges(
                dereference(value, oldRoot)['schema'],
                dereference(replacement, newRoot)['schema'],
                'response',
                oldRoot,
                newRoot,
                `${label}.${status}.headers.${header}`,
              ),
            );
        }
      }
      const oldSecurity = before['security'] ?? oldRoot['security'];
      const newSecurity = after['security'] ?? newRoot['security'];
      if (!equal(oldSecurity, newSecurity))
        findings.push(`${label}: changed authentication alternatives`);
    }
  }
  return findings;
}
