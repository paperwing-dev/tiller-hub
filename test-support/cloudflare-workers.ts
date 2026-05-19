export class DurableObject<TEnv = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: TEnv,
  ) {}
}
