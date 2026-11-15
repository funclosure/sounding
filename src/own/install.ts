// Imported before the live page by src/own/main.ts, so the bridge is in place
// when the page's own code first asks for it.
import { installOwn } from '../ui/socket'
import { ownBridge } from './bridge'
import { Prefs } from './prefs'
import { browserStore } from './store'

installOwn(ownBridge({ prefs: new Prefs(localStorage), store: browserStore() }))
