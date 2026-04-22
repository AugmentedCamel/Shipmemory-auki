import type { ContextCard } from '../shipmemory/types.js';

const MODEL = 'models/gemini-3.1-flash-live-preview';

/**
 * Build the Gemini Live WebSocket setup message from a ContextCard.
 * Matches the Android client's setup format exactly.
 */
export function buildSetupMessage(systemPrompt: string, card: ContextCard) {
  const setup: Record<string, unknown> = {
    model: MODEL,
    generationConfig: {
      responseModalities: ['AUDIO'],
      thinkingConfig: { thinkingBudget: 0 },
    },
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    realtimeInputConfig: {
      // Manual VAD. Mentra glasses deliver mic chunks only while the user is
      // speaking (device firmware VAD), so Gemini's server VAD has no silence
      // to detect — it would keep the turn open indefinitely and concatenate
      // multiple utterances. Instead we send explicit activityStart /
      // activityEnd + audioStreamEnd from the client based on the 500ms gap
      // in chunk arrival.
      automaticActivityDetection: { disabled: true },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ALL_INPUT',
    },
    contextWindowCompression: {
      slidingWindow: { targetTokens: 80000 },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  // Add tools if the card declares any
  if (card.tools.length > 0) {
    setup.tools = [
      {
        functionDeclarations: card.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return { setup };
}
