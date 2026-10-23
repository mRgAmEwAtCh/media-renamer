/**
 * An error caused by caller input rather than an internal failure.
 * The web server answers it with `status` (default 400) and its message.
 */
export class InputError extends Error {
  constructor(message, { status, ...options } = {}) {
    super(message, options);
    if (status !== undefined) this.status = status;
  }
}
