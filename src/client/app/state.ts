export enum AppState {
  /** Waiting for session to initialize */
  IDLE = 'IDLE',
  /** Camera active, scanning for QR codes at ~3fps */
  SCANNING = 'SCANNING',
  /** Gemini Live session active with voice + optional video */
  SESSION = 'SESSION',
}
