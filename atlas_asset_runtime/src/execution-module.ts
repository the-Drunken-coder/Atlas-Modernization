export type SafeStateContext = {
  signal: AbortSignal;
};

export interface ExecutionModule {
  readonly id: string;
  establishSafeState(context: SafeStateContext): Promise<void>;
}
