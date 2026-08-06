// The anagram challenge grades against one answer, so the pool must not contain
// a word whose letters spell another real word. The full check needs a
// dictionary and lives in scripts/audit-anagram-pool.mjs; these are the parts
// that hold with no dictionary present, so they run everywhere CI does.

import { expect, test, describe } from 'bun:test'
import { anagram } from '../src/generators/anagram.ts'
import { gradeDefault } from '../src/grader.ts'
import type { Generator } from '../src/types.ts'

function gradeWith(gen: Generator, response: string, answer: string): boolean | Promise<boolean> {
  return gen.grade ? gen.grade(response, answer) : gradeDefault(response, answer)
}

const letters = (w: string) => [...w].sort().join('')

// Sample every level rather than reading the private WORDS table, so the tests
// exercise what a caller actually receives.
async function poolFromGenerator(): Promise<Map<string, number>> {
  const seen = new Map<string, number>()
  for (let difficulty = 1; difficulty <= 10; difficulty++) {
    for (let i = 0; i < 500; i++) {
      const c = await anagram.generate(difficulty)
      seen.set(c.answer, difficulty)
    }
  }
  return seen
}

describe('anagram pool', async () => {
  const pool = await poolFromGenerator()

  test('samples a meaningful share of the pool', () => {
    expect(pool.size).toBeGreaterThanOrEqual(60)
  })

  test('no two words in the pool are anagrams of each other', () => {
    const byLetters = new Map<string, string[]>()
    for (const word of pool.keys()) {
      const k = letters(word)
      byLetters.set(k, [...(byLetters.get(k) ?? []), word])
    }
    const collisions = [...byLetters.values()].filter((ws) => ws.length > 1)
    expect(collisions).toEqual([])
  })

  test('the scrambled prompt is never the answer itself', async () => {
    // Otherwise the answer is printed in the question and any script passes.
    for (let difficulty = 1; difficulty <= 10; difficulty++) {
      for (let i = 0; i < 300; i++) {
        const c = await anagram.generate(difficulty)
        const shown = c.prompt.split(':').pop()!.trim().replace(/\s/g, '')
        expect(await gradeWith(anagram, shown, c.answer)).toBe(false)
      }
    }
  })

  test('the source word is still accepted', async () => {
    for (const word of pool.keys()) {
      expect(await gradeWith(anagram, word, word)).toBe(true)
      expect(await gradeWith(anagram, ` ${word.toUpperCase()} `, word)).toBe(true)
    }
  })

  test('every word in a difficulty bucket is the same length', () => {
    // Word length is what maps a word to a difficulty, so a word filed under the
    // wrong length silently makes that level easier or harder than intended.
    const byDifficulty = new Map<number, Set<number>>()
    for (const [word, difficulty] of pool) {
      const lengths = byDifficulty.get(difficulty) ?? new Set<number>()
      lengths.add(word.length)
      byDifficulty.set(difficulty, lengths)
    }
    for (const [difficulty, lengths] of byDifficulty) {
      expect({ difficulty, lengths: [...lengths] }).toEqual({ difficulty, lengths: [...lengths].slice(0, 1) })
    }
  })

  test('a different word is still rejected', async () => {
    expect(await gradeWith(anagram, 'zebra', 'house')).toBe(false)
    expect(await gradeWith(anagram, '', 'house')).toBe(false)
  })
})
