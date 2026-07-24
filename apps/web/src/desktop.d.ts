export interface PidexDesktopBridge {
  pickProject(): Promise<string | null>;
}

declare global {
  interface Window {
    pidexDesktop?: PidexDesktopBridge;
  }
}
