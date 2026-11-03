export function rethrowWithCause(error: unknown): never {
  if (error instanceof TypeError && error.cause instanceof Error) {
    throw new TypeError(`${error.message}: ${error.cause.message}`, { cause: error.cause });
  }
  throw error;
}
