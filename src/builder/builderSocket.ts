import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { redeemTicket } from '../services/wsTickets';
import { preparePipelineContext, finalizePipeline, addRequestedFiles } from './pipeline';
import { v1StandardResponseParser } from './interfaces/responseParser';
import { getSessionState, getUndoRedoDepths, moveCodePointer } from './codeHistory';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const MODEL = 'claude-sonnet-4-20250514';

// Track all connections per appId for broadcasting.
// TODO: Move to Redis pub/sub when scaling to multiple instances.
const appConnections = new Map<string, Set<WebSocket>>();

function broadcast(appId: string, data: any) {
  const connections = appConnections.get(appId);
  if (!connections) return;
  const message = JSON.stringify(data);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

export async function handleBuilderConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const ticket = url.searchParams.get('ticket');

  if (!ticket) {
    ws.close(4400, 'Missing ticket');
    return;
  }

  const auth = redeemTicket(ticket);
  if (!auth) {
    ws.close(4401, 'Invalid or expired ticket');
    return;
  }

  const { userId, appId } = auth;

  if (!appConnections.has(appId)) {
    appConnections.set(appId, new Set());
  }
  appConnections.get(appId)!.add(ws);

  // Send current session state on connect
  try {
    const state = await getSessionState(userId, appId);
    ws.send(JSON.stringify({ type: 'session_state', ...state }));
  } catch (err) {
    console.error('Failed to load session state:', err);
    ws.send(JSON.stringify({ type: 'error', error: 'Failed to load session' }));
  }

  let activeStream: ReturnType<typeof anthropic.messages.stream> | null = null;

  ws.on('message', async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'send_message':
        await handleSendMessage(msg.message);
        break;
      case 'stop':
        if (activeStream) {
          activeStream.abort();
          activeStream = null;
          broadcast(appId, { type: 'stream_stopped' });
        }
        break;
      case 'undo':
        await handleUndo();
        break;
      case 'redo':
        await handleRedo();
        break;
    }
  });

  ws.on('close', () => {
    appConnections.get(appId)?.delete(ws);
    if (appConnections.get(appId)?.size === 0) {
      appConnections.delete(appId);
    }
    if (activeStream) {
      activeStream.abort();
      activeStream = null;
    }
  });

  async function handleSendMessage(message: string) {
    if (!message?.trim()) return;

    let ctx: Awaited<ReturnType<typeof preparePipelineContext>>;
    try {
      ctx = await preparePipelineContext(userId, appId, message);
    } catch (err: any) {
      console.error('Pipeline context error:', err);
      ws.send(JSON.stringify({ type: 'error', error: 'Failed to prepare message' }));
      return;
    }

    broadcast(appId, {
      type: 'user_message',
      id: Date.now().toString(),
      content: message,
      timestamp: new Date().toISOString(),
    });

    broadcast(appId, { type: 'stream_start' });

    let fullText = '';
    let insideCodeBlock = false;
    let codeBlockBuffer = '';
    let pendingTagBuffer = '';
    const CODE_OPEN = '<pelko_code>';
    const CODE_CLOSE = '</pelko_code>';

    try {
      activeStream = anthropic.messages.stream({
        model: ctx.config.builderModel || MODEL,
        max_tokens: ctx.config.maxOutputTokens || 16384,
        system: ctx.context.system,
        messages: ctx.context.messages,
      });

      activeStream.on('text', (text: string) => {
        fullText += text;
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
                broadcast(appId, {
                  type: 'code_update',
                  label: parsed.label || 'Updated app',
                  files: parsed.files || {},
                  testData: parsed.testData || null,
                  previewDisplay: parsed.previewDisplay || { mode: 'single' },
                });
              } catch (e) {
                console.error('Failed to parse pelko_code block:', e);
                broadcast(appId, { type: 'code_error', error: 'Failed to parse code update' });
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
              if (textBefore.length > 0) broadcast(appId, { type: 'text_delta', text: textBefore });
              pendingTagBuffer = pendingTagBuffer.slice(openIndex + CODE_OPEN.length);
              insideCodeBlock = true;
              codeBlockBuffer = '';
              broadcast(appId, { type: 'code_start' });
            } else {
              let safeLength = pendingTagBuffer.length;
              for (let i = 1; i <= Math.min(CODE_OPEN.length, pendingTagBuffer.length); i++) {
                if (CODE_OPEN.startsWith(pendingTagBuffer.slice(-i))) {
                  safeLength = pendingTagBuffer.length - i;
                  break;
                }
              }
              if (safeLength > 0) {
                broadcast(appId, { type: 'text_delta', text: pendingTagBuffer.slice(0, safeLength) });
              }
              pendingTagBuffer = pendingTagBuffer.slice(safeLength);
              break;
            }
          }
        }
      });

      const finalMessage = await activeStream.finalMessage();
      activeStream = null;

      // Flush any remaining buffered text
      if (pendingTagBuffer.length > 0 && !insideCodeBlock) {
        broadcast(appId, { type: 'text_delta', text: pendingTagBuffer });
      }

      let finalUsage = {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      };

      // Handle file requests: make a non-streaming follow-up if Claude asked for files
      const tempParsed = v1StandardResponseParser({ fullText, usage: finalUsage });
      if (tempParsed.requestedFiles && tempParsed.requestedFiles.length > 0) {
        const updatedContext = addRequestedFiles(ctx.context, tempParsed.requestedFiles, ctx.session.currentCode);
        const followUp = await anthropic.messages.create({
          model: ctx.config.builderModel || MODEL,
          max_tokens: ctx.config.maxOutputTokens || 16384,
          system: updatedContext.system,
          messages: updatedContext.messages,
        });
        fullText = followUp.content
          .filter(b => b.type === 'text')
          .map(b => (b as any).text)
          .join('\n');
        finalUsage = {
          inputTokens: finalMessage.usage.input_tokens + followUp.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens + followUp.usage.output_tokens,
        };
        // Parse and broadcast the follow-up code update if any
        const followUpParsed = v1StandardResponseParser({ fullText, usage: finalUsage });
        if (followUpParsed.codeUpdate) {
          broadcast(appId, {
            type: 'code_update',
            ...followUpParsed.codeUpdate,
          });
        }
      }

      // Stage 3: persist messages, update session, fire memory updater
      await finalizePipeline(ctx.session, ctx.userMessage, fullText, finalUsage, ctx.config);

      // Get updated undo/redo depths after finalization
      const depths = await getUndoRedoDepths(ctx.session.id);

      broadcast(appId, {
        type: 'stream_done',
        usage: finalUsage,
        undoDepth: depths.undoDepth,
        redoDepth: depths.redoDepth,
      });

    } catch (err: any) {
      activeStream = null;
      if (err.name === 'AbortError') return; // Stop button — stream_stopped already broadcast
      console.error('Stream error:', err);
      broadcast(appId, { type: 'error', error: err.message || 'Stream failed' });
    }
  }

  async function handleUndo() {
    try {
      const result = await moveCodePointer(userId, appId, 'undo');
      if (result) {
        broadcast(appId, {
          type: 'code_state_changed',
          currentCode: result.currentCode,
          testData: result.testData,
          previewDisplay: result.previewDisplay,
          undoDepth: result.undoDepth,
          redoDepth: result.redoDepth,
          revertedLabels: result.revertedLabels,
        });
      }
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', error: 'Undo failed' }));
    }
  }

  async function handleRedo() {
    try {
      const result = await moveCodePointer(userId, appId, 'redo');
      if (result) {
        broadcast(appId, {
          type: 'code_state_changed',
          currentCode: result.currentCode,
          testData: result.testData,
          previewDisplay: result.previewDisplay,
          undoDepth: result.undoDepth,
          redoDepth: result.redoDepth,
          revertedLabels: result.revertedLabels,
        });
      }
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', error: 'Redo failed' }));
    }
  }
}
