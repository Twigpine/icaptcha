// Anagram / spelling: unscramble letters into a word. Word length grows with
// difficulty. Graded against the source word (normalized, case-insensitive).

import { choice, shuffle } from '../rng.ts'
import type { Generator, GeneratedChallenge } from '../types.ts'

// Curated, lower-cased, grouped by length so difficulty maps to length.
//
// Every word here has exactly one arrangement that spells a dictionary word:
// itself. That invariant is what makes the challenge well posed, because the
// grader accepts one answer, so a word whose letters also spell another real
// word fails a solver who happened to think of the other one. `star` and `rats`,
// `cloud` and `could`, `garden` and `danger` were all in this list.
//
// Re-run `bun run scripts/audit-anagram-pool.mjs` after adding a word.
const WORDS: Record<number, string[]> = {
  3: ['key', 'box', 'fox', 'pen', 'sky', 'toy', 'cow', 'log', 'ice', 'hat'],
  4: ['fish', 'gold', 'wind', 'bird', 'sand', 'cake', 'frog', 'milk', 'corn', 'desk'],
  5: ['house', 'water', 'plant', 'music', 'light', 'river', 'beach', 'bench', 'world', 'juice'],
  6: ['rocket', 'pencil', 'yellow', 'purple', 'summer', 'guitar', 'pocket', 'window', 'basket', 'hammer'],
  7: ['journey', 'diamond', 'gravity', 'machine', 'rainbow', 'thunder', 'village', 'crystal', 'morning', 'penguin'],
  8: ['mountain', 'elephant', 'sunshine', 'computer', 'hospital', 'language', 'umbrella', 'dinosaur', 'sandwich', 'airplane'],
  9: ['adventure', 'chocolate', 'butterfly', 'discovery', 'breakfast', 'invention', 'pineapple', 'crocodile', 'waterfall', 'astronaut'],
}

function lengthFor(d: number): number {
  return Math.min(9, 3 + Math.floor((d - 1) / 1.5))
}

export const anagram: Generator = {
  type: 'anagram',
  minLevel: 1,
  llm: false,
  generate(difficulty: number): GeneratedChallenge {
    const len = lengthFor(Math.max(1, difficulty))
    const word = choice(WORDS[len] ?? WORDS[5]!)
    let scrambled = word
    // Re-shuffle until it differs from the source.
    for (let i = 0; i < 8 && scrambled === word; i++) {
      scrambled = shuffle(word.split('')).join('')
    }
    return {
      prompt: `Unscramble these letters into a single English word: ${scrambled
        .split('')
        .join(' ')}`,
      answer: word,
    }
  },
  // Accept the source word (normalized, letters only).
  grade(response: string, answer: string): boolean {
    return response.trim().toLowerCase().replace(/[^a-z]/g, '') === answer.toLowerCase()
  },
}
