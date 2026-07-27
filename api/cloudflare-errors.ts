export interface CloudflareApiMessage {
  code?: number;
  message: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly method: string;
  readonly errors: CloudflareApiMessage[];

  constructor(options: {
    message: string;
    status: number;
    path: string;
    method: string;
    errors?: CloudflareApiMessage[];
  }) {
    super(options.message);
    this.name = "CloudflareApiError";
    this.status = options.status;
    this.path = options.path;
    this.method = options.method;
    this.errors = options.errors ?? [];
  }
}
