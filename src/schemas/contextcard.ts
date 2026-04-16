import { z } from 'zod';

export const ToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

export const ContextCardSchema = z.object({
  body: z.string().min(1),
  tools: z.array(ToolSchema).optional(),
  execute_url: z.string().optional(),
});

export type ContextCard = z.infer<typeof ContextCardSchema>;
export type Tool = z.infer<typeof ToolSchema>;
