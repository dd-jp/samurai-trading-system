export class ProtectiveReplaceError extends Error {
  constructor(
    readonly step: 'cancel' | 'place',
    message: string,
    options: { readonly cause: unknown },
  ) {
    super(message, options);
    this.name = 'ProtectiveReplaceError';
  }
}
