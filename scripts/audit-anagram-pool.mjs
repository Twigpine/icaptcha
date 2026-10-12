// Audit the anagram word pool: every word must be the ONLY dictionary word its
// letters spell. A word that shares its letters with another real word (star and
// rats, cloud and could) makes the challenge unanswerable-as-graded, because the
// grader accepts exactly one answer.
//
// Dev-only, and deliberately not a dependency: it reads a hunspell dictionary
// already on the machine and skips cleanly when there isn't one, so the runtime
// keeps its zero production dependencies.
//
//   bun run scripts/audit-anagram-pool.mjs
//
// On Debian/Ubuntu the dictionary comes from `apt install hunspell-en-us`;
// on macOS, `brew install hunspell` plus an en_US dictionary.

import { readFileSync, existsSync } from 'node:fs'

const DICT_CANDIDATES = [
  '/usr/share/hunspell/en_US',
  '/usr/share/myspell/en_US',
  '/opt/homebrew/share/hunspell/en_US',
  '/usr/local/share/hunspell/en_US',
]

const base = DICT_CANDIDATES.find((p) => existsSync(`${p}.dic`) && existsSync(`${p}.aff`))
if (!base) {
  console.log('no hunspell en_US dictionary found; skipping audit')
  console.log(`looked in: ${DICT_CANDIDATES.join(', ')}`)
  process.exit(0)
}

// Expand affix rules so inflections count. Without this, `rats` and `notes` look
// absent and the audit passes words that are in fact ambiguous.
function loadDictionary(prefix) {
  const aff = readFileSync(`${prefix}.aff`, 'latin1').split('\n')
  const rules = { SFX: new Map(), PFX: new Map() }
  for (let i = 0; i < aff.length; i++) {
    const p = aff[i].trim().split(/\s+/)
    if ((p[0] === 'SFX' || p[0] === 'PFX') && /^\d+$/.test(p[3] ?? '')) {
      const table = []
      for (let j = i + 1; j <= i + Number(p[3]) && j < aff.length; j++) {
        const q = aff[j].trim().split(/\s+/)
        if (q[0] === p[0] && q[1] === p[1]) {
          table.push({
            strip: q[2] === '0' ? '' : q[2],
            add: q[3] === '0' ? '' : (q[3] ?? '').split('/')[0],
            cond: q[4] ?? '.',
          })
        }
      }
      rules[p[0]].set(p[1], table)
      i += Number(p[3])
    }
  }

  const forms = new Set()
  const dic = readFileSync(`${prefix}.dic`, 'latin1').split('\n').slice(1)
  for (const line of dic) {
    const [raw, flags = ''] = line.trim().split('/')
    const word = (raw ?? '').trim().toLowerCase()
    if (!word || !/^[a-z]+$/.test(word)) continue
    forms.add(word)
    for (const flag of flags.trim()) {
      for (const { strip, add, cond } of rules.SFX.get(flag) ?? []) {
        if (strip && !word.endsWith(strip)) continue
        const stem = strip ? word.slice(0, -strip.length) : word
        if (cond !== '.' && !new RegExp(`${cond}$`).test(stem)) continue
        const form = stem + add
        if (/^[a-z]+$/.test(form)) forms.add(form)
      }
      for (const { strip, add } of rules.PFX.get(flag) ?? []) {
        if (strip) continue
        const form = add + word
        if (/^[a-z]+$/.test(form)) forms.add(form)
      }
    }
  }
  return forms
}

const forms = loadDictionary(base)
const letters = (w) => [...w].sort().join('')

const byLetters = new Map()
for (const w of forms) {
  const k = letters(w)
  if (!byLetters.has(k)) byLetters.set(k, [])
  byLetters.get(k).push(w)
}

// Read the pool straight out of the generator so the audit cannot drift from it.
const src = readFileSync(new URL('../src/generators/anagram.ts', import.meta.url), 'utf8')
const block = src.slice(src.indexOf('const WORDS'), src.indexOf('function lengthFor'))
const pool = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1])
if (pool.length === 0) {
  console.error('could not read the word pool from src/generators/anagram.ts')
  process.exit(1)
}

let bad = 0
for (const word of pool) {
  const others = (byLetters.get(letters(word)) ?? []).filter((w) => w !== word)
  if (others.length) {
    console.error(`  ${word} -> also spells: ${others.join(', ')}`)
    bad++
  }
}

console.log(`checked ${pool.length} words against ${forms.size.toLocaleString()} dictionary forms`)
if (bad) {
  console.error(`\n${bad} word(s) have another valid answer. Replace them.`)
  process.exit(1)
}
console.log('every word is the only dictionary word its letters spell')
