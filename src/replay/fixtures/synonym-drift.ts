import type { FixtureScript } from '../fixture'

/**
 * One concept under four labels: grief / mourning / losing / loss.
 * v0 token identity CANNOT merge these — the truth block documents the
 * expected failure (multiple marks), and the test pins it. Slice 2's
 * embedding resolver flips this fixture's expectation to a single mark:
 * that flip is the slice-2 acceptance test.
 */
export const synonymDrift: FixtureScript = {
  name: 'synonym-drift',
  description: 'Grief under four different labels',
  endT: 38_000,
  segments: [
    { startT: 0, endT: 4000, text: 'It has been a year and the grief still shows up unannounced' },
    { startT: 4500, endT: 8500, text: 'Grief is not what I expected, it is quieter' },
    { startT: 9000, endT: 13_000, text: 'The mourning part everyone understands, the casseroles, the cards' },
    { startT: 13_500, endT: 17_500, text: 'But mourning ends for everyone else and continues for you' },
    { startT: 18_000, endT: 22_000, text: 'Losing her rearranged the furniture of every single day' },
    { startT: 22_500, endT: 26_500, text: 'Losing her is present tense, that is what nobody says' },
    { startT: 27_000, endT: 31_000, text: 'The grief and the mourning are the same animal wearing different coats' },
    { startT: 31_500, endT: 35_500, text: 'I circle the loss the way a tongue finds a missing tooth' },
  ],
  truth: {
    driftGroup: ['grief', 'mourning', 'losing', 'loss'],
    notes: 'KNOWN v0 FAILURE, pinned: token identity produces >=2 separate marks for one concept. Slice-2 embedding resolver must reduce this to 1.',
  },
}
