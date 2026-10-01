export function credentialReader(
  owner: string,
): (value: string | undefined, envVar: string, field: string) => string {
  return (value, envVar, field) => {
    if (value === undefined || value.length === 0) {
      throw new Error(
        `${owner}: ${envVar} is not set. Provide it via the environment ` +
          `(.env.local) or pass { ${field} } explicitly.`,
      );
    }
    return value;
  };
}
