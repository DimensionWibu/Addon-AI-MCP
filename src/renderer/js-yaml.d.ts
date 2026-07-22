// Deklarasi tipe minimal untuk js-yaml (sudah ada di node_modules, tapi paket tak
// membawa .d.ts sendiri & @types/js-yaml tidak dipasang). Cukup untuk formatter Tools:
// round-trip load → dump. Renderer-only; tidak menyentuh main/preload.
declare module 'js-yaml' {
  export interface LoadOptions {
    filename?: string
    schema?: unknown
    json?: boolean
  }
  export interface DumpOptions {
    indent?: number
    lineWidth?: number
    noRefs?: boolean
    sortKeys?: boolean
    flowLevel?: number
  }
  export function load(input: string, options?: LoadOptions): unknown
  export function dump(obj: unknown, options?: DumpOptions): string
  export class YAMLException extends Error {
    constructor(reason?: string, mark?: unknown)
    reason: string
    mark: unknown
  }
}
