// Aliased to avoid shadowing the global WebSocket type we implement below
import TauriPluginWebSocket from '@tauri-apps/plugin-websocket';
import type { Message } from '@tauri-apps/plugin-websocket';

/**
 * Standard WebSocket implementation backed by @tauri-apps/plugin-websocket.
 *
 * The WebView's built-in WebSocket sends Origin: tauri://localhost which sync
 * servers reject. The Tauri WebSocket plugin routes through Rust, bypassing
 * this restriction. This class adapts its async/tagged-union API to the
 * standard browser WebSocket interface that RSocket expects.
 */
export class TauriWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  private _readyState: number = 0;
  private _binaryType: BinaryType = 'blob';
  private _url: string;
  private _ws: TauriPluginWebSocket | null = null;
  private _unsubscribe: (() => void) | null = null;

  onopen: ((this: WebSocket, ev: Event) => any) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => any) | null = null;
  onerror: ((this: WebSocket, ev: Event) => any) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => any) | null = null;

  readonly bufferedAmount = 0;
  readonly extensions = '';
  readonly protocol = '';

  get readyState(): number { return this._readyState; }
  get url(): string { return this._url; }
  get binaryType(): BinaryType { return this._binaryType; }
  set binaryType(value: BinaryType) { this._binaryType = value; }

  constructor(url: string) {
    super();
    this._url = url;
    this._readyState = this.CONNECTING;
    this._connect(url);
  }

  private async _connect(url: string): Promise<void> {
    try {
      const ws = await TauriPluginWebSocket.connect(url);
      this._ws = ws;

      this._unsubscribe = ws.addListener((msg: Message) => {
        this._handleMessage(msg);
      });

      this._readyState = this.OPEN;
      const event = new Event('open');
      this.dispatchEvent(event);
      this.onopen?.call(this as unknown as WebSocket, event);
    } catch (err) {
      this._readyState = this.CLOSED;
      const errorEvent = new Event('error');
      this.dispatchEvent(errorEvent);
      this.onerror?.call(this as unknown as WebSocket, errorEvent);

      const closeEvent = new CloseEvent('close', { code: 1006, reason: String(err) });
      this.dispatchEvent(closeEvent);
      this.onclose?.call(this as unknown as WebSocket, closeEvent);
    }
  }

  private _handleMessage(msg: Message): void {
    switch (msg.type) {
      case 'Text': {
        const event = new MessageEvent('message', { data: msg.data });
        this.dispatchEvent(event);
        this.onmessage?.call(this as unknown as WebSocket, event);
        break;
      }
      case 'Binary': {
        const bytes = new Uint8Array(msg.data as number[]);
        const data = this._binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
        const event = new MessageEvent('message', { data });
        this.dispatchEvent(event);
        this.onmessage?.call(this as unknown as WebSocket, event);
        break;
      }
      case 'Ping':
      case 'Pong':
        break;
      case 'Close': {
        const frame = msg.data as { code: number; reason: string } | null;
        this._readyState = this.CLOSED;
        const event = new CloseEvent('close', {
          code: frame?.code ?? 1000,
          reason: frame?.reason ?? '',
          wasClean: true,
        });
        this.dispatchEvent(event);
        this.onclose?.call(this as unknown as WebSocket, event);
        this._cleanup();
        break;
      }
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this._readyState !== this.OPEN || !this._ws) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }

    if (typeof data === 'string') {
      this._ws.send({ type: 'Text', data }).catch((e: unknown) => {
        console.error('[TauriWebSocket] send error:', e);
      });
    } else if (data instanceof ArrayBuffer) {
      this._ws.send({ type: 'Binary', data: Array.from(new Uint8Array(data)) }).catch((e: unknown) => {
        console.error('[TauriWebSocket] send error:', e);
      });
    } else if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this._ws.send({ type: 'Binary', data: Array.from(bytes) }).catch((e: unknown) => {
        console.error('[TauriWebSocket] send error:', e);
      });
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((buf) => {
        this._ws?.send({ type: 'Binary', data: Array.from(new Uint8Array(buf)) });
      }).catch((e: unknown) => {
        console.error('[TauriWebSocket] send blob error:', e);
      });
    }
  }

  close(code?: number, reason?: string): void {
    if (this._readyState === this.CLOSED || this._readyState === this.CLOSING) {
      return;
    }

    this._readyState = this.CLOSING;
    if (this._ws) {
      this._ws.disconnect().then(() => {
        this._readyState = this.CLOSED;
        const event = new CloseEvent('close', {
          code: code ?? 1000,
          reason: reason ?? '',
          wasClean: true,
        });
        this.dispatchEvent(event);
        this.onclose?.call(this as unknown as WebSocket, event);
        this._cleanup();
      }).catch(() => {
        this._readyState = this.CLOSED;
        this._cleanup();
      });
    } else {
      this._readyState = this.CLOSED;
      this._cleanup();
    }
  }

  private _cleanup(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._ws = null;
  }
}
