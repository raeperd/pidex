export {};

declare global {
  interface Window {
    pidexDesktop?: {
      pickProject(): Promise<string | null>;
    };
  }
}
