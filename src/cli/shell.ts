/** POSIX shell single-quoting: the value is always one literal word (embedded single quotes become '\'' ). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
