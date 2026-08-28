import type { FixtureScript } from '../fixture'

/**
 * Nine distinct worries against capacity 4: the reading must stay at 4
 * marks, and later worries must displace earlier ones deterministically.
 */
export const contention: FixtureScript = {
  name: 'contention',
  description: 'Nine money worries contending for four slots',
  endT: 60_000,
  configOverrides: { capacity: 4 },
  segments: [
    { startT: 0, endT: 4000, text: 'The rent is going up again and the rent was already most of my paycheck' },
    { startT: 4500, endT: 8500, text: 'Rent aside, the car is making that noise again' },
    { startT: 9000, endT: 13_000, text: 'The car needs a timing belt and the car shop quoted nine hundred' },
    { startT: 13_500, endT: 17_500, text: 'Insurance renewal is this month too, the insurance went up forty dollars' },
    { startT: 18_000, endT: 22_000, text: 'My laptop is six years old and the laptop battery is done' },
    { startT: 22_500, endT: 26_500, text: 'The vacation fund is what loses, the vacation moves to next year' },
    { startT: 27_000, endT: 31_000, text: 'The dentist appointment I cancelled twice, the dentist will fire me' },
    { startT: 31_500, endT: 35_500, text: 'The tax filing is due in six weeks and the tax folder is empty' },
    { startT: 36_000, endT: 40_000, text: 'The gym membership I never use, the gym is forty a month' },
    { startT: 40_500, endT: 44_500, text: 'The freezer died on Tuesday, the freezer was full of food' },
    { startT: 49_500, endT: 53_500, text: 'The vacation is cancelled again obviously, the dentist can wait' },
    { startT: 54_000, endT: 58_000, text: 'The tax filing cannot wait, the gym can go, the freezer cannot wait either' },
  ],
  truth: {
    notes: 'capacity 4 with 9+ recurring concepts: >=6 distinct concepts appear over the session, >=2 displacements occur, marks never exceed 4.',
  },
}
