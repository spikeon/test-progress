// The config of a setup: runners that the code does not know, and built-in runners to turn off.
//
// The mod reads two JSON files at each Bash call:
//   - the project config: .claude/test-progress.json in the project root, or in a parent folder of it
//   - the user config: ~/.claude/test-progress.json
// The project runners come first, then the user runners, then the built-in runners.

import type { Counts } from './parse'

// The patterns of a summary. Each count pattern has one group: the number. The mod adds the
// numbers of all the lines that match.
export type SummaryConfig = {
  // The line that marks the end of the run. Without a match the counts are not final.
  result: string
  passed?: string
  failed?: string
  skipped?: string
  total?: string
  // A match counts one pass: for a validator that prints no count when it passes.
  passIf?: string
}

export type RunnerConfig = {
  // The name in the band.
  name: string
  // A pattern that finds the runner in the Bash command.
  match: string
  // Without a summary the built-in summary lines and result lines give the counts.
  summary?: SummaryConfig
}

export type Config = {
  runners?: RunnerConfig[]
  // The names of built-in runners to turn off, such as "make test".
  disable?: string[]
}

type CompiledSummary = {
  result: RegExp
  passed?: RegExp
  failed?: RegExp
  skipped?: RegExp
  total?: RegExp
  passIf?: RegExp
}

export type Runner = { name: string; match: RegExp; summary?: CompiledSummary }

export type Setup = { runners: Runner[]; disabled: Set<string>; problems: string[] }

export const NO_SETUP: Setup = { runners: [], disabled: new Set(), problems: [] }

const FILE = '.claude/test-progress.json'

const pattern = (source: unknown, where: string, problems: string[], flags = ''): RegExp | undefined => {
  if (source === undefined) return undefined
  if (typeof source !== 'string') {
    problems.push(`${where}: not a string`)
    return undefined
  }
  try {
    return new RegExp(source, flags)
  } catch {
    problems.push(`${where}: not a valid pattern`)
    return undefined
  }
}

// Makes the runners of one parsed config file. A runner with a bad field is left out, and the
// problem is kept so that the mod can show it.
export function compile(config: unknown, file: string): Setup {
  const problems: string[] = []
  if (typeof config !== 'object' || config === null) {
    return { runners: [], disabled: new Set(), problems: [`${file}: not a JSON object`] }
  }
  const c = config as Config
  const runners: Runner[] = []
  for (const [i, r] of (Array.isArray(c.runners) ? c.runners : []).entries()) {
    const at = `${file} runners[${i}]`
    if (typeof r?.name !== 'string' || r.name === '') {
      problems.push(`${at}.name: missing`)
      continue
    }
    const before = problems.length
    const match = pattern(r.match, `${at}.match`, problems)
    let summary: CompiledSummary | undefined
    if (r.summary !== undefined) {
      const s = r.summary
      const result = pattern(s.result, `${at}.summary.result`, problems, 'm')
      if (result === undefined) problems.push(`${at}.summary.result: missing`)
      else {
        summary = {
          result,
          passed: pattern(s.passed, `${at}.summary.passed`, problems, 'gm'),
          failed: pattern(s.failed, `${at}.summary.failed`, problems, 'gm'),
          skipped: pattern(s.skipped, `${at}.summary.skipped`, problems, 'gm'),
          total: pattern(s.total, `${at}.summary.total`, problems, 'gm'),
          passIf: pattern(s.passIf, `${at}.summary.passIf`, problems, 'm'),
        }
      }
    }
    if (match === undefined) {
      if (problems.length === before) problems.push(`${at}.match: missing`)
      continue
    }
    if (problems.length > before) continue
    runners.push({ name: r.name, match, summary })
  }
  const disabled = new Set((Array.isArray(c.disable) ? c.disable : []).filter((d): d is string => typeof d === 'string'))
  return { runners, disabled, problems }
}

// Joins the setups in order: the first setup's runners come first.
export function merge(setups: Setup[]): Setup {
  return {
    runners: setups.flatMap(s => s.runners),
    disabled: new Set(setups.flatMap(s => [...s.disabled])),
    problems: setups.flatMap(s => s.problems),
  }
}

// The config files to read: the project root and each parent folder of it, then the user's home.
export function configFiles(root: string, home: string | null): string[] {
  const files: string[] = []
  let dir = root.replace(/\/+$/, '')
  while (dir !== '') {
    files.push(`${dir}/${FILE}`)
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  if (home !== null) {
    const user = `${home.replace(/\/+$/, '')}/${FILE}`
    if (!files.includes(user)) files.push(user)
  }
  return files
}

// Reads the counts of a run from the summary patterns of its runner.
export function configSummary(text: string, s: CompiledSummary): Omit<Counts, 'isSummary'> | null {
  if (!s.result.test(text)) return null
  const add = (p: RegExp | undefined) =>
    p === undefined ? 0 : [...text.matchAll(p)].reduce((n, m) => n + Number(m[1] ?? 0), 0)
  const passed = add(s.passed) + (s.passIf?.test(text) ? 1 : 0)
  const failed = add(s.failed)
  const skipped = add(s.skipped)
  const total = s.total === undefined ? passed + failed + skipped : add(s.total)
  return { passed, failed, skipped, total }
}
