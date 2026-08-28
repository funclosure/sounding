import type { FixtureScript } from '../fixture'

/** Five segments of garden planning, then 45 seconds of silence. */
export const slack: FixtureScript = {
  name: 'slack',
  description: 'Short think about the garden, then extended silence',
  endT: 70_000,
  segments: [
    { startT: 0, endT: 4000, text: 'I want to plan the garden this spring, what to plant where' },
    { startT: 5000, endT: 9000, text: 'Tomatoes failed last year because the shade from the fence got worse' },
    { startT: 10_000, endT: 14_000, text: 'Maybe tomatoes belong on the south bed this year' },
    { startT: 15_000, endT: 19_000, text: 'The south bed gets sun until four at least' },
    { startT: 20_000, endT: 24_000, text: 'Tomatoes and basil on the south bed, that could work' },
  ],
  truth: {
    circles: ['tomatoe'],
    notes: 'after 24s nothing new appears; weights decay; slack flag turns on. (normalizeToken folds "tomatoes" -> "tomatoe")',
  },
}
