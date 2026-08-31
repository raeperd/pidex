interface Window {
  pidexDesktop?: {
    readonly usesIntegratedTitleBar: boolean;
    pickProject(): Promise<string | null>;
  };
}
