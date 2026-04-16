/** Raw video frame for processing. */
export interface Frame {
  /** RGBA pixel data */
  data: Uint8Array;
  width: number;
  height: number;
  /** Optional JPEG-encoded version of this frame (for sending to Gemini) */
  jpeg?: Buffer;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ContextCard {
  body: string;
  tools: ToolDeclaration[];
  execute_url: string | null;
  session_id: string | null;
  trace_url: string | null;
}

/**
 * Pluggable context provider interface.
 * Base app never imports ShipMemory internals — only this interface.
 */
export interface ContextProvider {
  scan(frames: AsyncIterable<Frame>): Promise<ContextCard>;
}
