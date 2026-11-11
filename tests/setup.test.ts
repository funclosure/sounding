import { describe, it, expect } from 'vitest'
import { describeSetup } from '../src/live/setup'
import { setupLines } from '../src/ui/setup'

describe('describeSetup', () => {
  it('reports the local speech model, the subscription model and the API switch', () => {
    const s = describeSetup({ interpreter: 'claude-sub', transcriber: 'whisper', lang: 'en-US' }, false, { SOUNDING_API: 'off', SOUNDING_WHISPER_MODEL: 'models/ggml-large-v3-turbo.bin' })
    expect(s).toMatchObject({ transcriber: 'whisper', hearsModel: 'large-v3-turbo', interpreter: 'claude-sub', lang: 'en-US', api: false, ownInstructions: false })
    expect(s.thinksModel).toBeTruthy()
  })
  it('names no model for providers that are not local or on the login', () => {
    const s = describeSetup({ interpreter: 'gemini', transcriber: 'gemini', lang: 'en-US' }, true, {})
    expect(s).toMatchObject({ hearsModel: null, thinksModel: null, api: true, ownInstructions: true })
  })
})

describe('setupLines', () => {
  it('says in plain words what listens, what understands and that nothing is spent', () => {
    const lines = Object.fromEntries(setupLines({ transcriber: 'whisper', hearsModel: 'large-v3-turbo', interpreter: 'claude-sub', thinksModel: 'claude-sonnet-5-5', lang: 'en-US', api: false, ownInstructions: true }))
    expect(lines['hears with']).toMatch(/Whisper \(large-v3-turbo\), on the machine itself/)
    expect(lines['understands with']).toBe('Claude (claude-sonnet-5-5), on your subscription.')
    expect(lines['the wrap']).toMatch(/your own instructions/)
    expect(lines['paid API']).toMatch(/^Off/)
  })
  it('marks paid providers as paid and the model-free baseline as having no wrap', () => {
    const paid = Object.fromEntries(setupLines({ transcriber: 'gemini', hearsModel: null, interpreter: 'claude', thinksModel: null, lang: 'en-US', api: true, ownInstructions: false }))
    expect(paid['hears with']).toMatch(/paid API/)
    expect(paid['understands with']).toMatch(/paid API/)
    expect(paid['paid API']).toMatch(/^Allowed/)
    const base = Object.fromEntries(setupLines({ transcriber: 'whisper', hearsModel: null, interpreter: 'recurrence', thinksModel: null, lang: 'en-US', api: false, ownInstructions: false }))
    expect(base['the wrap']).toMatch(/Not written/)
  })
})
