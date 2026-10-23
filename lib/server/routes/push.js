import { InputError } from '../../errors.js';

/** Web push subscriptions for "job needs attention" notifications. */
export function pushRoutes({ push }) {
  return {
    async '/api/push/key'() {
      return { publicKey: await push.publicKey() };
    },

    async '/api/push/subscribe'(body) {
      try {
        await push.subscribe(body.subscription);
      } catch (error) {
        throw new InputError(error.message);
      }
      return { ok: true };
    },

    async '/api/push/unsubscribe'(body) {
      if (typeof body.endpoint === 'string') await push.unsubscribe(body.endpoint);
      return { ok: true };
    },
  };
}
