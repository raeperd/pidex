export interface PidexDesktopBridge {
  readonly usesIntegratedTitleBar: boolean;
  pickProject(): Promise<string | null>;
}

declare global {
  interface Window {
    pidexDesktop?: PidexDesktopBridge;
  }
}
