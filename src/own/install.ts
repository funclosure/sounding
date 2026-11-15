// Imported before the live page by src/own/main.ts, so the bridge is in place
// when the page's own code first asks for it.
import { installOwn } from '../ui/socket'
import { ownBridge } from './bridge'
import { holdsKeys, takeCarried } from './keys'
import { takeInvite } from './invite'
import { Prefs } from './prefs'
import { browserStore } from './store'

// Keys carried from another screen arrive after the #. They are taken out of the address before anything else runs.
const carried = takeCarried(location, history)
// An invite link from Victor: its token is taken out of the address the same way.
const inviteToken = takeInvite(location, history)
// A code's link opened in a tab already showing this page changes only the #: load again, so it is taken the same way.
addEventListener('hashchange', () => { if (holdsKeys(location.hash) || /(^#|&)invite=/.test(location.hash)) location.reload() })
installOwn(ownBridge({ prefs: new Prefs(localStorage), store: browserStore(), carried, inviteToken, siteUrl: () => `${location.origin}/` }))
