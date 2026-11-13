export interface AppErrorOptions {
  messageKey?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Operational error with a stable machine code and a translation key, so the
 * WhatsApp renderer can answer in the seller's language.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageKey: string | undefined;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.messageKey = options.messageKey;
    this.details = options.details;
  }
}

export const badRequest = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(400, code, message, options);

export const unauthorized = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(401, code, message, options);

export const forbidden = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(403, code, message, options);

export const notFound = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(404, code, message, options);

export const conflict = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(409, code, message, options);

export const tooManyRequests = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(429, code, message, options);

export const unprocessable = (code: string, message: string, options?: AppErrorOptions): AppError =>
  new AppError(422, code, message, options);
