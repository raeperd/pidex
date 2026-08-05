export interface PidexDesktopBridge {
  readonly usesIntegratedTitleBar: boolean;
  takeAuthGrant(): Promise<string | null>;
  pickProject(): Promise<string | null>;
}

declare global {
  interface Window {
    pidexDesktop?: PidexDesktopBridge;
  }
}
