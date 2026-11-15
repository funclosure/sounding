// Where an invite stands, shared by the relay and the invites page (which must not pull in the relay's prompts).
export type InviteState = 'ok' | 'expired' | 'used' | 'revoked' | 'cap'

/** An invite that can no longer be used, and so may be removed: withdrawn, expired or used up. */
export const removable = (state: InviteState): boolean => state === 'revoked' || state === 'expired' || state === 'used'
