import type { FixtureScript } from '../fixture'

/**
 * Wedding planning for 60s, then a hard shift to a job offer. Old concepts
 * must be displaced after the shift (>=2 displacements by fixture end), with zero
 * displacement churn before it (Word Cloud for Meeting finding). A bounded
 * displacement-latency assertion is slice-2 tuning work.
 * capacity 4 so the shift forces contention rather than slot-filling.
 */
export const topicShift: FixtureScript = {
  name: 'topic-shift',
  description: 'Wedding planning, then a hard shift to a job offer',
  endT: 132_000,
  configOverrides: { capacity: 4 },
  segments: [
    { startT: 0, endT: 4000, text: 'The venue question is the first decision we have to settle' },
    { startT: 4500, endT: 8500, text: 'Everything else about the wedding waits on the venue' },
    { startT: 9000, endT: 13_000, text: 'The barn venue was beautiful but the catering rules were strict' },
    { startT: 13_500, endT: 17_500, text: 'Outside catering is not allowed there which changes the budget' },
    { startT: 18_000, endT: 22_000, text: 'The budget was already tight before we counted the guests' },
    { startT: 22_500, endT: 26_500, text: 'A hundred and forty guests if we invite every cousin' },
    { startT: 27_000, endT: 31_000, text: 'Catering per guest is where the budget actually explodes' },
    { startT: 31_500, endT: 35_500, text: 'We could trim the guests or trim the catering' },
    { startT: 36_000, endT: 40_000, text: 'The venue deposit is due before we know the guest count' },
    { startT: 40_500, endT: 44_500, text: 'A smaller venue caps the guests which caps the catering' },
    { startT: 45_000, endT: 49_000, text: 'So the venue decision is really the budget decision' },
    { startT: 49_500, endT: 53_500, text: 'The garden venue allows outside catering at least' },
    { startT: 54_000, endT: 58_000, text: 'Venue first, then guests, then catering, then the budget falls out' },
    // ---- shift at 60s ----
    { startT: 60_000, endT: 64_000, text: 'Completely different subject, the offer came through this morning' },
    { startT: 64_500, endT: 68_500, text: 'The offer means relocation by January' },
    { startT: 69_000, endT: 73_000, text: 'Relocation in the middle of wedding planning is absurd' },
    { startT: 73_500, endT: 77_500, text: 'The team is the reason to say yes, the team is genuinely great' },
    { startT: 78_000, endT: 82_000, text: 'The deadline on the offer is next Friday' },
    { startT: 82_500, endT: 86_500, text: 'Relocation costs would eat into savings fast' },
    { startT: 87_000, endT: 91_000, text: 'The team lead called me herself about the offer' },
    { startT: 91_500, endT: 95_500, text: 'The deadline is what makes it real, one week to decide on relocation' },
    { startT: 96_000, endT: 100_000, text: 'If the offer is the future the deadline should not scare me' },
    { startT: 100_500, endT: 104_500, text: 'The team, the relocation, the deadline, that is the whole decision' },
    { startT: 105_000, endT: 109_000, text: 'The relocation is the real question now, relocation means leaving the apartment' },
    { startT: 109_500, endT: 113_500, text: 'The team keeps calling, the team really wants an answer on the offer' },
    { startT: 114_000, endT: 118_000, text: 'The deadline is real, the deadline does not move, the offer deadline is Friday' },
    { startT: 118_500, endT: 122_500, text: 'The deadline forces the relocation decision, the team is waiting on the deadline' },
    { startT: 123_000, endT: 127_000, text: 'Relocation, team, deadline, the offer is still the whole decision now' },
    { startT: 127_500, endT: 131_500, text: 'The relocation and the team and the deadline, the offer will not wait either' },
  ],
  truth: {
    topicShiftAt: 60_000,
    notes: 'phase 1 concepts: venue/catering/budget/guest; phase 2: offer/relocation/team/deadline. No displacements before the shift; at least 2 after it; >=2 of 4 final marks phase-2.',
  },
}
