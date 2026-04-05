// Type declarations for optional/uninstalled dependencies.
// These modules are only present at runtime on machines that need them.

declare module 'pino' {
  const pino: any;
  export default pino;
}

declare module 'qrcode-terminal' {
  const qrcode: {
    generate(input: string, opts?: { small?: boolean }): void;
  };
  export default qrcode;
}

declare module '@whiskeysockets/baileys' {
  export const Browsers: any;
  export const DisconnectReason: any;
  export type WAMessage = any;
  export type WASocket = any;
  export function downloadMediaMessage(...args: any[]): any;
  export function makeCacheableSignalKeyStore(...args: any[]): any;
  export function makeWASocket(...args: any[]): any;
  export function useMultiFileAuthState(...args: any[]): any;
}

declare module '@slack/bolt' {
  export class App {
    constructor(opts: any);
    start(): Promise<void>;
    stop(): Promise<void>;
    client: any;
    message(handler: any): void;
    error(handler: any): void;
  }
  export enum LogLevel {
    ERROR = 'error',
    WARN = 'warn',
    INFO = 'info',
    DEBUG = 'debug',
  }
}

declare module 'pdf-parse' {
  export class PDFParse {
    constructor(opts: any);
    getText(): Promise<{ text: string; total?: number }>;
    getInfo(): Promise<{ total?: number } | null>;
    destroy(): Promise<void>;
  }
}

declare module 'grammy' {
  export class Bot {
    constructor(token: string);
    command(cmd: string, handler: any): void;
    on(event: string, handler: any): void;
    catch(handler: any): void;
    start(opts?: any): void;
    stop(): void;
    api: any;
  }
}
