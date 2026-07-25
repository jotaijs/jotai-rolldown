import { withMagicString, type RolldownString } from 'rolldown-string'
import type { Plugin } from 'rolldown'
import type { ESTree } from 'rolldown/utils'
import { Visitor } from 'rolldown/utils'
import { ScopedVisitor, type VisitorContext } from 'oxc-unshadowed-visitor'
import type { JotaiPluginOptions } from './types.js'
import { createAtomImportMap, type AtomImportMap } from './atomImportMap.js'
import { escapeRegExp, getDefaultExportAtomName, getFileKey } from './utils.js'

export type { JotaiPluginOptions } from './types.js'

const JOTAI_CACHE_INIT = `globalThis.jotaiAtomCache = globalThis.jotaiAtomCache || {
  cache: new Map(),
  get(name, inst) {
    if (this.cache.has(name)) return this.cache.get(name);
    this.cache.set(name, inst);
    return inst;
  }
};`

type TransformRecordData =
  | { kind: 'debug-label'; label: string; insertPos: number }
  | { kind: 'debug-label-default-export'; exportStart: number; declStart: number; declEnd: number }
  | { kind: 'refresh'; key: string; start: number; end: number }

function buildCodeFilter(atomNames: ReadonlyArray<string>): RegExp {
  const needles = new Set<string>(['jotai', 'atom'])
  for (const atomName of atomNames) {
    if (atomName.length > 0) needles.add(atomName)
  }
  return new RegExp([...needles].map(escapeRegExp).join('|'))
}

function createCacheKey(fileKey: string, accessPath: ReadonlyArray<string>): string {
  return `${fileKey}/${accessPath.join('.')}`
}

function wrapWithCacheGetExpression(
  s: RolldownString,
  key: string,
  prefixPos: number,
  suffixPos: number,
): void {
  s.prependRight(prefixPos, `globalThis.jotaiAtomCache.get(${JSON.stringify(key)}, `)
  s.appendLeft(suffixPos, `)`)
}

function getCacheInsertionPosition(program: ESTree.Program): number {
  for (const statement of program.body) {
    if (!(statement.type === 'ExpressionStatement' && typeof statement.directive === 'string')) {
      return statement.start
    }
  }
  return 0
}

function isExpressionExportDefault(
  declaration: ESTree.ExportDefaultDeclaration['declaration'],
): declaration is ESTree.Expression {
  if (
    declaration.type !== 'FunctionDeclaration' &&
    declaration.type !== 'ClassDeclaration' &&
    declaration.type !== 'TSInterfaceDeclaration' &&
    declaration.type !== 'TSDeclareFunction'
  ) {
    declaration satisfies ESTree.Expression
    return true
  } else {
    return false
  }
}

function scanForAtomCalls(
  node: ESTree.Expression,
  accessPath: string[],
  atomImportMap: AtomImportMap,
  fileKey: string,
  ctx: VisitorContext<TransformRecordData>,
): void {
  if (node.type === 'CallExpression') {
    const name = atomImportMap.getAtomImportName(node.callee)
    if (name !== null) {
      const key = createCacheKey(fileKey, accessPath)
      ctx.record({ name, node, data: { kind: 'refresh', key, start: node.start, end: node.end } })
    }
    return
  }
  if (node.type === 'ArrayExpression') {
    for (const [index, element] of node.elements.entries()) {
      if (element === null || element.type === 'SpreadElement') continue
      scanForAtomCalls(element, [...accessPath, index.toString()], atomImportMap, fileKey, ctx)
    }
    return
  }
  if (node.type === 'ObjectExpression') {
    for (const property of node.properties) {
      if (property.type === 'Property') {
        let keyName: string
        if (property.shorthand) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion --- shorthand properties must have Identifier keys
          keyName = (property.key as ESTree.IdentifierReference).name
        } else {
          keyName =
            property.key.type === 'Identifier'
              ? property.key.name
              : property.key.type === 'Literal'
                ? String(property.key.value)
                : property.computed
                  ? `[computed:(${property.key.start},${property.key.end})]`
                  : 'unknown'
        }
        if (
          property.value.type !== 'FunctionExpression' &&
          property.value.type !== 'ArrowFunctionExpression'
        ) {
          scanForAtomCalls(
            property.value as ESTree.Expression,
            [...accessPath, keyName],
            atomImportMap,
            fileKey,
            ctx,
          )
        }
      }
    }
  }
}

export function jotaiPlugin(options: JotaiPluginOptions = {}): Plugin {
  const atomNames = options.atomNames ?? []
  let debugLabelEnabled = options.debugLabel!
  let reactRefreshEnabled = options.reactRefresh!
  const codeFilter = buildCodeFilter(atomNames)

  const plugin: Plugin = {
    name: 'rolldown-plugin-jotai',
    // @ts-expect-error Vite-specific property
    enforce: 'pre',

    // @ts-expect-error Vite-specific hook
    configResolved(config) {
      debugLabelEnabled ??= !config.isProduction
      reactRefreshEnabled ??= !config.isProduction
      if (!debugLabelEnabled && !reactRefreshEnabled) {
        delete plugin.transform
      }
    },

    outputOptions() {
      if ('viteVersion' in this.meta) return
      debugLabelEnabled ??= process.env.NODE_ENV === 'development'
      reactRefreshEnabled ??= process.env.NODE_ENV === 'development'
      if (!debugLabelEnabled && !reactRefreshEnabled) {
        delete plugin.transform
      }
    },

    transform: {
      filter: {
        id: /\.[jt]sx?$/,
        code: {
          include: codeFilter,
        },
      },

      handler: withMagicString(function (this, s, id, meta) {
        const lang = id.endsWith('.tsx')
          ? 'tsx'
          : id.endsWith('.ts')
            ? 'ts'
            : id.endsWith('.jsx')
              ? 'jsx'
              : 'js'
        const program = meta?.ast ?? this.parse(s.original, { lang })

        const atomImportMap = createAtomImportMap(atomNames)
        for (const statement of program.body) {
          if (statement.type === 'ImportDeclaration') {
            atomImportMap.addFromImportDecl(statement)
          }
        }

        const fileKey = getFileKey(id)
        let functionDepth = 0
        const exportedVarDecls = new Set<ESTree.VariableDeclaration>()

        function handleVarDecl(
          node: ESTree.VariableDeclaration,
          containerEnd: number,
          ctx: VisitorContext<TransformRecordData>,
        ): void {
          for (const declarator of node.declarations) {
            if (!declarator.init) continue
            if (debugLabelEnabled && declarator.id.type === 'Identifier') {
              const name = atomImportMap.getAtomImportName(declarator.init)
              if (name !== null) {
                ctx.record({
                  name,
                  node: declarator,
                  data: {
                    kind: 'debug-label',
                    label: declarator.id.name,
                    insertPos: containerEnd,
                  },
                })
              }
            }
            if (reactRefreshEnabled && functionDepth === 0) {
              const key =
                declarator.id.type === 'Identifier' ? declarator.id.name : '[missing-declarator]'
              scanForAtomCalls(declarator.init, [key], atomImportMap, fileKey, ctx)
            }
          }
        }

        const scopedVisitor = new ScopedVisitor<TransformRecordData>({
          trackedNames: atomImportMap.getTrackedNames(),
          walk: (program, visitor) => new Visitor(visitor).visit(program),
          visitor: {
            FunctionDeclaration() {
              functionDepth++
            },
            'FunctionDeclaration:exit'() {
              functionDepth--
            },
            FunctionExpression() {
              functionDepth++
            },
            'FunctionExpression:exit'() {
              functionDepth--
            },
            ArrowFunctionExpression() {
              functionDepth++
            },
            'ArrowFunctionExpression:exit'() {
              functionDepth--
            },

            ExportDefaultDeclaration(node, ctx) {
              if (debugLabelEnabled && isExpressionExportDefault(node.declaration)) {
                const name = atomImportMap.getAtomImportName(node.declaration)
                if (name !== null) {
                  ctx.record({
                    name,
                    node,
                    data: {
                      kind: 'debug-label-default-export',
                      exportStart: node.start,
                      declStart: node.declaration.start,
                      declEnd: node.declaration.end,
                    },
                  })
                }
              }
            },

            ExportNamedDeclaration(node, ctx) {
              if (node.declaration?.type === 'VariableDeclaration') {
                exportedVarDecls.add(node.declaration)
                handleVarDecl(node.declaration, node.end, ctx)
              }
            },

            VariableDeclaration(node, ctx) {
              if (exportedVarDecls.has(node)) return
              handleVarDecl(node, node.end, ctx)
            },
          },
        })

        const records = scopedVisitor.walk(program)

        let usedAtom = false
        for (const record of records) {
          const data = record.data
          switch (data.kind) {
            case 'debug-label': {
              s.appendRight(
                data.insertPos,
                `\n${data.label}.debugLabel = ${JSON.stringify(data.label)};`,
              )
              break
            }
            case 'debug-label-default-export': {
              const atomName = getDefaultExportAtomName(id)

              s.move(data.declStart, data.declEnd, data.exportStart)
              s.prependLeft(data.exportStart, `const ${atomName} = `)
              s.appendRight(
                data.exportStart,
                `;\n${atomName}.debugLabel = ${JSON.stringify(atomName)};\n`,
              )
              s.appendRight(data.declEnd, `${atomName};`)
              break
            }
            case 'refresh': {
              wrapWithCacheGetExpression(s, data.key, data.start, data.end)
              usedAtom = true
              break
            }
          }
        }

        if (reactRefreshEnabled && usedAtom) {
          const insertPos = getCacheInsertionPosition(program)
          s.appendLeft(insertPos, `${JOTAI_CACHE_INIT}\n`)
        }
      }),
    },
  }
  return plugin
}

export default jotaiPlugin
