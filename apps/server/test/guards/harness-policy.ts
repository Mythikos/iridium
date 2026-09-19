/** AST checks shared by the harness policy guards; string fixtures and prose are not executable code. */
import { parseSync, Visitor, type Node } from 'oxc-parser';

import { locate, type Source } from './source-scan.ts';

export type HarnessRule = 'mocks' | 'sleep' | 'clock' | 'test-auth';

function memberName(node: Node): string | null {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function pathOf(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ChainExpression') return pathOf(node.expression);
  if (node.type !== 'MemberExpression') return '';
  const property = memberName(node.property);
  return property === null ? '' : `${pathOf(node.object)}.${property}`;
}

export function harnessViolations(source: Source, rule: HarnessRule): string[] {
  const parsed = parseSync(source.path, source.raw);
  if (parsed.errors.length > 0)
    return parsed.errors.map((error) => `${source.path}: parse failed: ${error.message}`);
  const findings = new Set<string>();
  const timers = new Set(['setTimeout', 'setInterval']);
  const timerNamespaces = new Set<string>();
  const vitest = new Set(['vi', 'vitest']);
  const spyFunctions = new Set<string>();
  const allowedMockFile = /\.(?:unit|component)\.spec\.tsx?$/u.test(source.path);
  const flag = (node: Node): void => {
    findings.add(locate(source, node.start));
  };
  new Visitor({
    ImportDeclaration(node) {
      const module = node.source.value;
      for (const specifier of node.specifiers) {
        if (
          module === 'node:timers' ||
          module === 'node:timers/promises' ||
          module === 'timers' ||
          module === 'timers/promises'
        ) {
          if (
            specifier.type === 'ImportNamespaceSpecifier' ||
            specifier.type === 'ImportDefaultSpecifier'
          )
            timerNamespaces.add(specifier.local.name);
          if (
            specifier.type === 'ImportSpecifier' &&
            ['setTimeout', 'setInterval'].includes(memberName(specifier.imported) ?? '')
          )
            timers.add(specifier.local.name);
        }
        if (module === 'vitest') {
          if (specifier.type === 'ImportSpecifier') {
            const name = memberName(specifier.imported);
            if (name === 'vi' || name === 'vitest') vitest.add(specifier.local.name);
            if (name === 'mock' || name === 'spyOn' || name === 'doMock')
              spyFunctions.add(specifier.local.name);
          } else vitest.add(specifier.local.name);
        }
      }
      if (rule === 'mocks' && !allowedMockFile && /^msw(?:\/|$)/u.test(module)) flag(node);
    },
  }).visit(parsed.program);
  new Visitor({
    CallExpression(node) {
      const path = pathOf(node.callee);
      const pieces = path.split('.');
      const root = pieces[0] ?? '';
      const last = pieces.at(-1) ?? '';
      const globalTimer =
        timers.has(path) ||
        ((root === 'globalThis' || root === 'global' || timerNamespaces.has(root)) &&
          ['setTimeout', 'setInterval'].includes(last));
      if (
        rule === 'mocks' &&
        !allowedMockFile &&
        (spyFunctions.has(path) || (vitest.has(root) && ['mock', 'doMock', 'spyOn'].includes(last)))
      )
        flag(node);
      if (
        rule === 'sleep' &&
        (globalTimer || last === 'waitForTimeout' || path === 'delay' || path === 'sleep')
      )
        flag(node);
      if (
        rule === 'clock' &&
        (globalTimer ||
          /^(?:globalThis\.|global\.)?Date\.now$/u.test(path) ||
          /^(?:globalThis\.|global\.)?Date$/u.test(path))
      )
        flag(node);
    },
    NewExpression(node) {
      if (
        rule === 'clock' &&
        /^(?:globalThis\.|global\.)?Date$/u.test(pathOf(node.callee)) &&
        node.arguments.length === 0
      )
        flag(node);
    },
    Identifier(node) {
      if (rule === 'test-auth' && /^(?:NODE_ENV|IRIDIUM_(?:E2E|FAULT)(?:_.*)?)$/u.test(node.name))
        flag(node);
    },
    MemberExpression(node) {
      if (
        rule === 'test-auth' &&
        /^(?:NODE_ENV|IRIDIUM_(?:E2E|FAULT)(?:_.*)?)$/u.test(memberName(node.property) ?? '')
      )
        flag(node);
    },
    ImportExpression(node) {
      if (
        rule === 'mocks' &&
        !allowedMockFile &&
        node.source.type === 'Literal' &&
        typeof node.source.value === 'string' &&
        /^msw(?:\/|$)/u.test(node.source.value)
      )
        flag(node);
    },
  }).visit(parsed.program);
  return [...findings];
}
