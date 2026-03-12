import Anthropic from '@anthropic-ai/sdk';
import { FullContext } from './contextAssembler';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export interface RawLLMResponse {
  fullText: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function v1StandardLLMCaller(
  context: FullContext,
  config: Record<string, any>
): Promise<RawLLMResponse> {
  const response = await anthropic.messages.create({
    model: config.builderModel || 'claude-sonnet-4-20250514',
    max_tokens: config.maxOutputTokens || 16384,
    temperature: config.temperature || 0.7,
    system: context.system,
    messages: context.messages,
  });

  const fullText = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n');

  return {
    fullText,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
  };
}
