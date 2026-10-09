/**
 * POST /api/inngest — the durable workflow endpoint.
 *
 * Inngest calls this to execute and retry fulfillment steps. It is the piece
 * that makes spec section 21 ("a crash never loses a paid order") true: the
 * webhook enqueues an event here, and if the worker executing it dies, Inngest
 * redelivers rather than the order being stranded in FULFILLMENT_PENDING.
 *
 * The handlers themselves are built in `@/inngest/functions`, which is the
 * single definition of the function graph. Registering a second, differently
 * configured graph in src/instrumentation.ts is deliberate: that registration
 * exists to FAIL FAST on a malformed function graph at boot, not to serve
 * traffic. This route is the one Inngest actually calls.
 */

export const runtime = 'nodejs';
// Inngest's dev tooling and its execution protocol both rely on reading the
// live request body, so this route must never be statically cached.
export const dynamic = 'force-dynamic';

export { GET, POST, PUT } from '@/inngest/functions';