export interface InputErrorOptions extends ErrorOptions {
  /** HTTP status the web server answers with. */
  status?: number;
}

/**
 * An error caused by caller input rather than an internal failure.
 * The web server answers it with `status` (default 400) and its message.
 */
export class InputError extends Error {
  declare status?: number;

  constructor(message: string, { status, ...options }: InputErrorOptions = {}) {
    super(message, options);
    if (status !== undefined) this.status = status;
  }
}
