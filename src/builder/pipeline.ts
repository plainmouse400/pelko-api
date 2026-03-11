import { BuilderSession, getOrCreateSession, storeMessage } from '../services/sessionService';
import { trackUsage } from '../services/usageService';
import { v1HybridContextAssembler, FullContext } from './interfaces/contextAssembler';
import { v1StandardLLMCaller, RawLLMResponse } from './interfaces/llmCaller';
import { v1StandardResponseParser, ParsedResponse } from './interfaces/responseParser';
import { v1HierarchicalMemoryUpdater } from './interfaces/memoryUpdater';
import { supabase } from '../config/supabase';

export interface PipelineResult {
  conversationText: string;
  codeUpdate: ParsedResponse['codeUpdate'];
  usage: { inputTokens: number; outputTokens: number };
  sessionId: string;
}

export async function runBuilderPipeline(
  userId: string,
  appId: string,
  creatorMessage: string
): Promise<PipelineResult> {
  // 1. Load/create session
  const session = await getOrCreateSession(userId, appId);
  const config = session.resolvedConfig;

  // 2. Store user message
  await storeMessage(session.id, 'user', creatorMessage, null, null);
  session.messageCount += 1;

  // 3. Assemble context
  const context = await dispatchContextAssembler(session, creatorMessage, config);

  // 4. Call LLM
  let llmResponse = await dispatchLLMCaller(context, config);

  // 5. Parse response
  let parsed = dispatchResponseParser(llmResponse, config);

  // 6. Handle file requests (follow-up call if needed)
  if (parsed.requestedFiles && parsed.requestedFiles.length > 0) {
    const updatedContext = addRequestedFiles(context, parsed.requestedFiles, session.currentCode);
    llmResponse = await dispatchLLMCaller(updatedContext, config);
    parsed = dispatchResponseParser(llmResponse, config);
  }

  // 7. Store assistant message
  await storeMessage(session.id, 'assistant', parsed.conversationText, parsed.codeUpdate, llmResponse.usage);

  // 8. Update session code state
  if (parsed.codeUpdate?.files) {
    const updatedCode = { ...session.currentCode, ...parsed.codeUpdate.files };
    await supabase.from('builder_sessions').update({ current_code: updatedCode }).eq('id', session.id);
    session.currentCode = updatedCode;
  }

  // 9. Fire-and-forget memory update (also handles summary quality sampling)
  dispatchMemoryUpdater(session, {
    userMessage: creatorMessage,
    assistantMessage: parsed.conversationText,
    codeUpdate: parsed.codeUpdate,
  }, config).catch(err => console.error('Memory updater error (non-blocking):', err));

  // 10. Track usage — builder call (primary cost)
  await trackUsage({
    userId, appId,
    model: config.builderModel || 'claude-sonnet-4-20250514',
    tokensIn: llmResponse.usage.inputTokens,
    tokensOut: llmResponse.usage.outputTokens,
    interactionType: 'builder',
  });

  // 11. Track per-component metrics (all fire-and-forget)
  const metricsToInsert = [
    { session_id: session.id, metric_name: 'context_tokens_per_call', metric_value: context.contextTokenEstimate },
    { session_id: session.id, metric_name: 'builder_input_tokens', metric_value: llmResponse.usage.inputTokens },
    { session_id: session.id, metric_name: 'builder_output_tokens', metric_value: llmResponse.usage.outputTokens },
    { session_id: session.id, metric_name: 'memories_retrieved_count', metric_value: context.memoriesRetrieved },
    { session_id: session.id, metric_name: 'files_included_count', metric_value: context.filesIncluded.length },
  ];
  supabase.from('builder_metrics').insert(metricsToInsert).then().catch(() => {});

  // 12. Retrieval relevance scoring (every 50th request, fire-and-forget)
  if (context.retrievedMemoryDetails.length > 0 && session.messageCount % 50 === 0) {
    scoreRetrievalRelevance(
      session, creatorMessage, parsed.conversationText,
      context.retrievedMemoryDetails, config
    ).catch(err => console.error('Retrieval scoring error (non-blocking):', err));
  }

  return {
    conversationText: parsed.conversationText,
    codeUpdate: parsed.codeUpdate,
    usage: llmResponse.usage,
    sessionId: session.id,
  };
}

/**
 * Score whether retrieved memories were relevant to the request.
 * Runs as a cheap Haiku call, fire-and-forget.
 */
async function scoreRetrievalRelevance(
  session: BuilderSession,
  creatorMessage: string,
  assistantResponse: string,
  retrievedMemories: Array<{ id: string; level: number; content: string; similarity: number }>,
  config: Record<string, any>
): Promise<void> {
  const anthropic = new (await import('@anthropic-ai/sdk')).default({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });

  const memorySummaries = retrievedMemories
    .map((m, i) => `Memory ${i + 1} (similarity: ${m.similarity.toFixed(3)}): ${m.content}`)
    .join('\n\n');

  const response = await anthropic.messages.create({
    model: config.summaryModel || 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    temperature: 0,
    system: 'You evaluate whether retrieved memory chunks were relevant to a conversation exchange. Score from 1-5 where 1 = completely irrelevant, 3 = somewhat relevant, 5 = exactly what was needed. Return ONLY a JSON object: {"score": N, "notes": "brief explanation"}',
    messages: [{
      role: 'user',
      content: `Creator message: ${creatorMessage}\n\nAssistant response (first 300 chars): ${assistantResponse.substring(0, 300)}\n\nRetrieved memories:\n${memorySummaries}`,
    }],
  });

  const responseText = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('').trim();

  try {
    const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());

    await supabase.from('builder_retrieval_scores').insert({
      session_id: session.id,
      creator_message: creatorMessage,
      assistant_response: assistantResponse.substring(0, 500),
      retrieved_memories: retrievedMemories,
      relevance_score: parsed.score,
      relevance_notes: parsed.notes,
    });

    // Also track as a metric for easy aggregation
    await supabase.from('builder_metrics').insert({
      session_id: session.id,
      metric_name: 'retrieval_relevance_score',
      metric_value: parsed.score,
    });

    // Track the Haiku cost for this scoring call
    await trackUsage({
      userId: session.userId, appId: session.appId,
      model: config.summaryModel || 'claude-haiku-4-5-20251001',
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      interactionType: 'retrieval_scoring',
    });
  } catch (e) {
    console.error('Failed to parse retrieval score:', e);
  }
}

// ---- Interface dispatchers ----

function dispatchContextAssembler(session: BuilderSession, message: string, config: Record<string, any>): Promise<FullContext> {
  const name = config.interfaces?.contextAssembler || 'v1-hybrid';
  switch (name) {
    case 'v1-hybrid': return v1HybridContextAssembler(session, message);
    default: throw new Error(`Unknown context assembler: ${name}`);
  }
}

function dispatchLLMCaller(context: FullContext, config: Record<string, any>): Promise<RawLLMResponse> {
  const name = config.interfaces?.llmCaller || 'v1-standard';
  switch (name) {
    case 'v1-standard': return v1StandardLLMCaller(context, config);
    default: throw new Error(`Unknown LLM caller: ${name}`);
  }
}

function dispatchResponseParser(response: RawLLMResponse, config: Record<string, any>): ParsedResponse {
  const name = config.interfaces?.responseParser || 'v1-standard';
  switch (name) {
    case 'v1-standard': return v1StandardResponseParser(response);
    default: throw new Error(`Unknown response parser: ${name}`);
  }
}

function dispatchMemoryUpdater(
  session: BuilderSession,
  exchange: { userMessage: string; assistantMessage: string; codeUpdate: any },
  config: Record<string, any>
): Promise<void> {
  const name = config.interfaces?.memoryUpdater || 'v1-hierarchical';
  switch (name) {
    case 'v1-hierarchical': return v1HierarchicalMemoryUpdater(session, exchange, config);
    default: throw new Error(`Unknown memory updater: ${name}`);
  }
}

function addRequestedFiles(context: FullContext, requestedFiles: string[], currentCode: Record<string, string>): FullContext {
  let additionalCode = '\n\n## Requested Files\n';
  for (const filename of requestedFiles) {
    const code = currentCode[filename];
    additionalCode += code
      ? `\n### ${filename}\n\`\`\`tsx\n${code}\n\`\`\`\n`
      : `\n### ${filename}\n(file not found)\n`;
  }

  return {
    ...context,
    system: context.system + additionalCode,
    messages: [
      ...context.messages.slice(0, -1),
      { role: 'user' as const, content: `Here are the files you requested. Please continue.\n\n${context.messages[context.messages.length - 1].content}` },
    ],
    filesIncluded: [...context.filesIncluded, ...requestedFiles],
  };
}
