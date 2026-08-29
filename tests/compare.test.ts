import { describe, it, expect } from 'vitest'
import { createReplay } from '../src/replay/runner'
import { circling } from '../src/replay/fixtures/circling'
import { formatComparison } from '../src/cli/compare'

describe('formatComparison', () => {
  it('renders readings, displacements, and counters for both logs', async () => {
    const a = createReplay(circling)
    await a.runner.runToEnd()
    const b = createReplay(circling)
    await b.runner.runToEnd()
    const out = formatComparison(
      { name: 'circling.recurrence', events: a.session.log.all() },
      { name: 'circling.recurrence-2', events: b.session.log.all() },
    )
    expect(out).toContain('FINAL READING')
    expect(out).toContain('sister')
    expect(out).toContain('DISPLACEMENTS')
    expect(out).toContain('COST / LATENCY')
    expect(out).toContain('$0.0000')
    expect(out).toContain('circling.recurrence-2')
  })
})
