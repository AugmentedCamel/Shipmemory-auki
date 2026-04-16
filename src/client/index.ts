import { AppServer, AppSession } from '@mentra/sdk';
import { env } from './config/env.js';
import { SessionOrchestrator } from './app/session.js';

class ShipMemoryApp extends AppServer {
  private orchestrators = new Map<string, SessionOrchestrator>();

  constructor() {
    super({
      packageName: env.PACKAGE_NAME,
      apiKey: env.MENTRAOS_API_KEY,
      port: env.PORT,
    });
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    console.log(`[ShipMemory] New session: ${sessionId} user: ${userId}`);
    session.layouts.showTextWall('ShipMemory starting…');

    const orchestrator = new SessionOrchestrator(session, sessionId, env);
    this.orchestrators.set(sessionId, orchestrator);

    // Clean up Gemini WebSocket when Mentra session disconnects
    session.events.onDisconnected((data) => {
      console.log(`[ShipMemory] Session disconnected: ${sessionId}`, data);
      this.cleanupSession(sessionId);
    });

    await orchestrator.start();
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`[ShipMemory] Session stop requested: ${sessionId} reason: ${reason}`);
    this.cleanupSession(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    const orchestrator = this.orchestrators.get(sessionId);
    if (orchestrator) {
      orchestrator.destroy();
      this.orchestrators.delete(sessionId);
    }
  }
}

const app = new ShipMemoryApp();
app.start().catch(console.error);
console.log(`[ShipMemory] Mentra client listening on port ${env.PORT}`);
