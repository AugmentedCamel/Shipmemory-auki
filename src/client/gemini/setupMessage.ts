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
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        silenceDurationMs: 500,
        prefixPaddingMs: 40,
      },
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
