// Global type declarations for OpenClaw plugin environment
declare const setTimeout: (
  callback: (...args: any[]) => void,
  ms: number,
  ...args: any[]
) => NodeJS.Timeout;
declare const fetch: typeof globalThis.fetch;
declare const console: Console;
declare const process: {
  exit: (code?: number) => never;
};
