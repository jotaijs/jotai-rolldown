import type { ESTree } from 'rolldown/utils'

export interface AtomImportMap {
  addFromImportDecl(importDecl: ESTree.ImportDeclaration): void
  isAtomImport(expression: ESTree.Expression): boolean
}

export function createAtomImportMap(atomNames: string[]): AtomImportMap {
  const named = new Set<string>(atomNames)
  const namespace = new Set<string>()

  const isAtomImport = (expression: ESTree.Expression): boolean => {
    if (expression.type === 'CallExpression') {
      return isAtomImport(expression.callee)
    }
    if (expression.type === 'Identifier') {
      return named.has(expression.name)
    }
    if (
      expression.type === 'MemberExpression' &&
      expression.object.type === 'Identifier' &&
      expression.property.type === 'Identifier'
    ) {
      return namespace.has(expression.object.name) && ATOM_IMPORT_SET.has(expression.property.name)
    }
    return false
  }

  return {
    addFromImportDecl(importDecl) {
      if (!importDecl.source.value.startsWith('jotai')) return

      for (const specifier of importDecl.specifiers) {
        if (specifier.type === 'ImportSpecifier') {
          const importedName =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value
          if (ATOM_IMPORT_SET.has(importedName)) {
            named.add(specifier.local.name)
          }
          continue
        }

        if (specifier.type === 'ImportNamespaceSpecifier') {
          namespace.add(specifier.local.name)
        }
      }
    },
    isAtomImport,
  }
}

const ATOM_IMPORTS = [
  // Core
  'atom',
  'atomFamily',
  'atomWithDefault',
  'atomWithObservable',
  'atomWithReducer',
  'atomWithReset',
  'atomWithStorage',
  'freezeAtom',
  'loadable',
  'selectAtom',
  'splitAtom',
  'unwrap',
  // jotai-xstate
  'atomWithMachine',
  // jotai-immer
  'atomWithImmer',
  // jotai-valtio
  'atomWithProxy',
  // jotai-trpc + jotai-relay
  'atomWithQuery',
  'atomWithMutation',
  'atomWithSubscription',
  // jotai-redux + jotai-zustand
  'atomWithStore',
  // jotai-location
  'atomWithHash',
  'atomWithLocation',
  // jotai-optics
  'focusAtom',
  // jotai-form
  'atomWithValidate',
  'validateAtoms',
  // jotai-cache
  'atomWithCache',
  // jotai-recoil
  'atomWithRecoilValue',
  // jotai-tanstack-query
  'atomWithQuery',
  'atomWithQueries',
  'atomWithInfiniteQuery',
  'atomWithMutation',
  'atomWithSuspenseQuery',
  'atomWithSuspenseInfiniteQuery',
  'atomWithMutationState',
  // jotai-eager
  'eagerAtom',
  // jotai-effect
  'atomEffect',
] as const

const ATOM_IMPORT_SET = new Set<string>(ATOM_IMPORTS)
