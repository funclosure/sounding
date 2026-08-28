import type { FixtureScript } from '../fixture'

/**
 * A job decision where the expected concepts are salary/commute/offer —
 * and what the talking actually circles is the sister. The reading must
 * show that (BRIEF.md: "that is not a failure of extraction, that is the
 * reading").
 */
export const circling: FixtureScript = {
  name: 'circling',
  description: 'Job-offer decision that keeps returning to the sister',
  endT: 82_000,
  segments: [
    { startT: 0, endT: 4000, text: 'So I got the offer letter yesterday and I keep staring at it instead of signing it' },
    { startT: 5000, endT: 9000, text: 'The salary is fine, honestly the salary was never the problem here' },
    { startT: 10_000, endT: 14_000, text: 'My sister called last night and we talked about the offer for an hour' },
    { startT: 15_000, endT: 19_000, text: 'She said something about how I always stall when things get real' },
    { startT: 20_000, endT: 24_000, text: 'The commute would be longer but people survive commutes, that part is fine' },
    { startT: 25_000, endT: 29_000, text: 'My sister went through the same thing two years ago when she moved to Denver' },
    { startT: 30_000, endT: 34_000, text: 'I keep coming back to what my sister said about stalling' },
    { startT: 35_000, endT: 39_000, text: 'The team seems good, the manager seems good, the work seems fine' },
    { startT: 40_000, endT: 44_000, text: 'Maybe this is not about the job at all, maybe it is about my sister being the brave one' },
    { startT: 45_000, endT: 49_000, text: 'She took her offer in a week and never looked back' },
    { startT: 50_000, endT: 54_000, text: 'I have been comparing myself to my sister since we were kids' },
    { startT: 55_000, endT: 59_000, text: 'The offer expires Friday and I still have not signed it' },
    { startT: 60_000, endT: 64_000, text: 'Every time I think about signing I think about calling my sister first' },
    { startT: 65_000, endT: 69_000, text: 'That is the pattern, I cannot decide anything without her blessing' },
    { startT: 70_000, endT: 74_000, text: 'The job is fine, the offer is fine, the salary is fine' },
    { startT: 75_000, endT: 79_000, text: 'It was never about the offer, it was about my sister' },
  ],
  truth: {
    circles: ['sister'],
    surfacesBy: { sister: 40_000 },
    notes: 'sister must surface by 40s, persist to the end, and finish in the top 3 by prominence',
  },
}
