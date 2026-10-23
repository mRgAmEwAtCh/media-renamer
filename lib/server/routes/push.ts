import { InputError } from '../../errors.ts';
import type { RouteContext } from '../context.ts';
import type { RequestBody, Routes } from '../http.ts';

/** Web push subscriptions for "job needs attention" notifications. */
export function pushRoutes({ push }: RouteContext): Routes {
  return {
    async '/api/push/key'() {
      return { publicKey: await push.publicKey() };
    },

    async '/api/push/subscribe'(body: RequestBody) {
      try {
        await push.subscribe(body.subscription);
      } catch (error) {
        throw new InputError((error as Error).message);
      }
      return { ok: true };
    },

    async '/api/push/unsubscribe'(body: RequestBody) {
      if (typeof body.endpoint === 'string') await push.unsubscribe(body.endpoint);
      return { ok: true };
    },
  };
}
