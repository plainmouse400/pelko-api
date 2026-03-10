import Anthropic from '@anthropic-ai/sdk';
import { buildConversationPrompt } from '../prompts/builderSystem';
import { trackUsage } from './usageService';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const MODEL = 'claude-sonnet-4-20250514';

export interface BuilderResponse {
  // The conversational text to show the creator
  conversationText: string;

  // Code changes (null if the AI just responded conversationally with no code changes)
  codeUpdate: {
    label: string;
    files: Record<string, string>;
    testData: any;
    previewDisplay: any;
  } | null;

  // Token usage
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export async function runBuilderAgent(
  userId: string,
  appId: string | null,
  currentCode: Record<string, string>,
  conversationHistory: { role: string; content: string }[],
  creatorMessage: string,
  appMemory: any
): Promise<BuilderResponse> {
  const { system, messages } = buildConversationPrompt(
    currentCode,
    conversationHistory,
    creatorMessage,
    appMemory
  );

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    messages,
  });

  // Extract the text content
  const fullText = response.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n');

  // Parse out any <pelko_code> blocks
  const codeMatch = fullText.match(/<pelko_code>([\s\S]*?)<\/pelko_code>/);

  let conversationText = fullText.replace(/<pelko_code>[\s\S]*?<\/pelko_code>/, '').trim();
  let codeUpdate: BuilderResponse['codeUpdate'] = null;

  if (codeMatch) {
    try {
      const parsed = JSON.parse(codeMatch[1].trim());
      codeUpdate = {
        label: parsed.label || 'Updated app',
        files: parsed.files || {},
        testData: parsed.testData || null,
        previewDisplay: parsed.previewDisplay || { mode: 'single' },
      };
    } catch (e) {
      console.error('Failed to parse pelko_code block:', e);
      // If parsing fails, just return the conversation text without code
    }
  }

  const usage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // Track usage
  await trackUsage({
    userId,
    appId,
    model: MODEL,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
    interactionType: 'builder',
  });

  return {
    conversationText,
    codeUpdate,
    usage,
  };
}
