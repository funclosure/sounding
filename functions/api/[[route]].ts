// Cloudflare Pages runs this for every request under /api on the hosted site:
// the friends' relay (src/relay/relay.ts). Its database (DB), the two provider
// keys and the admin secret are the Pages project's bindings and secrets; see
// docs/FRIENDS.md. Without them it answers that invitations are not set up.
import { handleRelay, type RelayEnv } from '../../src/relay/relay'

export const onRequest = (ctx: { request: Request; env: RelayEnv }): Promise<Response> => handleRelay(ctx.request, ctx.env)
