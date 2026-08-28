import type { FixtureScript } from '../fixture'
import { circling } from './circling'
import { slack } from './slack'
import { topicShift } from './topic-shift'
import { contention } from './contention'
import { synonymDrift } from './synonym-drift'

export const FIXTURES: FixtureScript[] = [circling, slack, topicShift, contention, synonymDrift]
