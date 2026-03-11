import Anthropic from '@anthropic-ai/sdk';
import { buildConversationPrompt } from '../prompts/builderSystem';
import { trackUsage } from './usageService';
import { Response } from 'express';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const MODEL = 'claude-sonnet-4-20250514';

export async function streamBuilderAgent(
  res: Response,
  userId: string,
  appId: string | null,
  currentCode: Record<string, string>,
  conversationHistory: { role: string; content: string }[],
  creatorMessage: string,
  appMemory: any
): Promise<void> {
  const { system, messages } = buildConversationPrompt(
    currentCode,
    conversationHistory,
    creatorMessage,
    appMemory
  );

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable Nginx/proxy buffering
  });

  // Helper to send an SSE event
  function sendEvent(event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Flush to prevent proxy buffering
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  }

  // State for tracking where we are in the response
  let insideCodeBlock = false;
  let codeBlockBuffer = '';
  let pendingTagBuffer = '';

  const CODE_OPEN = '<pelko_code>';
  const CODE_CLOSE = '</pelko_code>';

  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages,
    });

    // If the client disconnects (stop button), abort the Anthropic stream
    res.on('close', () => {
      stream.abort();
    });

    stream.on('text', (text: string) => {
      pendingTagBuffer += text;

      while (pendingTagBuffer.length > 0) {
        if (insideCodeBlock) {
          const closeIndex = pendingTagBuffer.indexOf(CODE_CLOSE);
          if (closeIndex !== -1) {
            codeBlockBuffer += pendingTagBuffer.slice(0, closeIndex);
            pendingTagBuffer = pendingTagBuffer.slice(closeIndex + CODE_CLOSE.length);
            insideCodeBlock = false;

            try {
              const parsed = JSON.parse(codeBlockBuffer.trim());
              sendEvent('code_update', {
                label: parsed.label || 'Updated app',
                files: parsed.files || {},
                testData: parsed.testData || null,
                previewDisplay: parsed.previewDisplay || { mode: 'single' },
              });
            } catch (e) {
              console.error('Failed to parse streamed pelko_code block:', e);
              sendEvent('code_error', { error: 'Failed to parse code update' });
            }
            codeBlockBuffer = '';
          } else {
            let safeLength = pendingTagBuffer.length;
            for (let i = 1; i <= Math.min(CODE_CLOSE.length, pendingTagBuffer.length); i++) {
              if (CODE_CLOSE.startsWith(pendingTagBuffer.slice(-i))) {
                safeLength = pendingTagBuffer.length - i;
                break;
              }
            }
            codeBlockBuffer += pendingTagBuffer.slice(0, safeLength);
            pendingTagBuffer = pendingTagBuffer.slice(safeLength);
            break;
          }
        } else {
          const openIndex = pendingTagBuffer.indexOf(CODE_OPEN);
          if (openIndex !== -1) {
            const textBefore = pendingTagBuffer.slice(0, openIndex);
            if (textBefore.length > 0) {
              sendEvent('text', { text: textBefore });
            }
            pendingTagBuffer = pendingTagBuffer.slice(openIndex + CODE_OPEN.length);
            insideCodeBlock = true;
            codeBlockBuffer = '';
            sendEvent('code_start', {});
          } else {
            let safeLength = pendingTagBuffer.length;
            for (let i = 1; i <= Math.min(CODE_OPEN.length, pendingTagBuffer.length); i++) {
              if (CODE_OPEN.startsWith(pendingTagBuffer.slice(-i))) {
                safeLength = pendingTagBuffer.length - i;
                break;
              }
            }

            if (safeLength > 0) {
              sendEvent('text', { text: pendingTagBuffer.slice(0, safeLength) });
            }
            pendingTagBuffer = pendingTagBuffer.slice(safeLength);
            break;
          }
        }
      }
    });

    const finalMessage = await stream.finalMessage();

    // Flush any remaining buffered text
    if (pendingTagBuffer.length > 0 && !insideCodeBlock) {
      sendEvent('text', { text: pendingTagBuffer });
    }

    const usage = {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    };

    await trackUsage({
      userId,
      appId,
      model: MODEL,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      interactionType: 'builder',
    });

    sendEvent('done', { usage });

  } catch (err: any) {
    // If the error is from client disconnect (stop button), just end quietly
    if (err.name === 'AbortError' || res.writableEnded) {
      return;
    }
    console.error('Streaming builder error:', err);
    sendEvent('error', { error: err.message || 'Streaming failed' });
  }

  res.end();
}
