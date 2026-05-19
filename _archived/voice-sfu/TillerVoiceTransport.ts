/**
 * Custom VoiceTransport that connects via the authenticated Tiller voice route
 * at /api/voice/session instead of the default /agents/<party>/<room> path.
 *
 * This preserves CF Access JWT authentication on the WebSocket upgrade
 * and avoids routeAgentRequest scanning all DO bindings.
 */

// VoiceTransport interface from @cloudflare/voice — inlined to avoid
// module resolution issues with the /client subpath.
interface VoiceTransport {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
  readonly connected: boolean;
  sendJSON(data: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  connect(): void;
  disconnect(): void;
}

export class TillerVoiceTransport implements VoiceTransport {
  private socket: WebSocket | null = null;
  private hubUrl: string;
  private sessionId: string;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error?: unknown) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

  constructor(hubUrl: string, sessionId: string) {
    this.hubUrl = hubUrl;
    this.sessionId = sessionId;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  sendJSON(data: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  connect(): void {
    // If there's already an active or connecting socket, skip.
    // Check readyState instead of just truthiness — a CLOSING/CLOSED socket
    // left over from a previous disconnect() should be replaced.
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    const wsBase = this.hubUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${wsBase}/api/voice/session?sessionId=${encodeURIComponent(this.sessionId)}`;

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    // Capture the socket in the closure so stale event handlers from a
    // previous socket (whose close event fires asynchronously after
    // disconnect()) don't clobber the current socket reference.
    socket.addEventListener("open", () => {
      if (this.socket === socket) this.onopen?.();
    });
    socket.addEventListener("close", () => {
      // Only clear if this is still the active socket. When React strict
      // mode double-mounts, the old socket's async close event fires AFTER
      // a new socket has been assigned — without this guard it would null
      // out the new socket and break the connection.
      if (this.socket === socket) {
        this.socket = null;
        this.onclose?.();
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.onerror?.();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket === socket) this.onmessage?.(event.data);
    });

    this.socket = socket;
  }

  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.close();
    }
  }
}
