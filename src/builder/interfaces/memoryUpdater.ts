import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../../config/supabase';
import { BuilderSession, updateAppBrief } from '../../services/sessionService';
import { generateEmbedding } from '../../services/embeddingService';
import { trackUsage } from '../../services/usageService';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

interface Exchange {
  userMessage: string;
  assistantMessage: string;
  codeUpdate: any | null;
}

export async function v1HierarchicalMemoryUpdater(
  session: BuilderSession,
  exchange: Exchange,
  config: Record<string, any>
): Promise<void> {
  const memConfig = config.memoryUpdaterConfig || {};
  const summaryModel = config.summaryModel || 'claude-haiku-4-5-20251001';

  // Note: Each sub-function tracks its own token usage via trackUsage()
  // with interactionType set to 'brief_update', 'file_index', or 'summarization'.
  // This gives us per-component cost visibility in builder_usage.
  await Promise.all([
    updateBrief(session, exchange, summaryModel),
    updateFileIndex(session, exchange, summaryModel),
    checkAndCreateSummaries(session, memConfig, summaryModel),
  ]);
}

// ---- App Brief ----

async function updateBrief(session: BuilderSession, exchange: Exchange, model: string): Promise<void> {
  const { data: existing } = await supabase
    .from('builder_app_briefs')
    .select('content')
    .eq('session_id', session.id)
    .single();

  const currentBrief = existing?.content || getEmptyBriefTemplate();
  const codeChangeSummary = exchange.codeUpdate
    ? `Files changed: ${Object.keys(exchange.codeUpdate.files).join(', ')}. Label: ${exchange.codeUpdate.label}`
    : 'No code changes.';

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1200,
    temperature: 0,
    system: 'You maintain a living brief for an app being built. Update it based on the latest exchange. Add new decisions, preferences, features. Remove outdated info. Keep concise — under 800 tokens. Preserve markdown section structure. Return ONLY the updated brief.',
    messages: [{
      role: 'user',
      content: `Current brief:\n${currentBrief}\n\nLatest exchange:\nCreator: ${exchange.userMessage}\nBuilder: ${exchange.assistantMessage}\nCode changes: ${codeChangeSummary}\n\nReturn the updated brief:`,
    }],
  });

  const updatedBrief = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('\n').trim();

  await updateAppBrief(session.id, session.appId, updatedBrief);

  // Track cost for this component
  await trackUsage({
    userId: session.userId, appId: session.appId,
    model, tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens,
    interactionType: 'brief_update',
  });
}

function getEmptyBriefTemplate(): string {
  return `# App Brief\n\n## Identity\n(Not yet defined)\n\n## Architecture\n(Not yet defined)\n\n## Design\n(Not yet defined)\n\n## Screens & Features\n(None built yet)\n\n## Key Decisions\n(None yet)\n\n## Creator Preferences\n(Not yet known)\n\n## Open Items\n(None yet)`;
}

// ---- File Index ----

async function updateFileIndex(session: BuilderSession, exchange: Exchange, model: string): Promise<void> {
  if (!exchange.codeUpdate?.files) return;
  const changedFiles = Object.keys(exchange.codeUpdate.files);
  if (changedFiles.length === 0) return;

  const fileSnippets = changedFiles.map(f => `${f}: ${exchange.codeUpdate!.files[f].substring(0, 300)}`).join('\n\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 500,
    temperature: 0,
    system: 'Generate a file index. For each file, return 4-6 keywords and a one-line description. Return ONLY a JSON array: [{"filename":"...","keywords":[...],"description":"..."}]',
    messages: [{ role: 'user', content: fileSnippets }],
  });

  const responseText = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();

  try {
    const newEntries = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    const existingIndex = [...session.fileIndex];
    for (const entry of newEntries) {
      const idx = existingIndex.findIndex(e => e.filename === entry.filename);
      if (idx >= 0) existingIndex[idx] = entry;
      else existingIndex.push(entry);
    }

    await supabase.from('builder_sessions').update({ file_index: existingIndex }).eq('id', session.id);
    session.fileIndex = existingIndex;
  } catch (e) {
    console.error('Failed to parse file index response:', e);
  }
}

// ---- Hierarchical Summarization ----

async function checkAndCreateSummaries(session: BuilderSession, memConfig: Record<string, any>, model: string): Promise<void> {
  await maybeCreateChunkSummary(session, memConfig.chunkSize || 10, model);
  await maybeCreateSectionSummary(session, memConfig.sectionsPerRollup || 5, model);
  await maybeCreateEraSummary(session, memConfig.erasPerRollup || 5, model);
}

async function maybeCreateChunkSummary(session: BuilderSession, chunkSize: number, model: string): Promise<void> {
  const { data: latestChunk } = await supabase
    .from('builder_summaries')
    .select('message_range_end')
    .eq('session_id', session.id)
    .eq('level', 1)
    .order('message_range_end', { ascending: false })
    .limit(1);

  const summarizedUpTo = latestChunk?.[0]?.message_range_end || 0;
  if (session.messageCount - summarizedUpTo < chunkSize) return;

  const startSeq = summarizedUpTo + 1;
  const endSeq = summarizedUpTo + chunkSize;

  const { data: messages } = await supabase
    .from('builder_messages')
    .select('role, content')
    .eq('session_id', session.id)
    .gte('sequence_number', startSeq)
    .lte('sequence_number', endSeq)
    .order('sequence_number', { ascending: true });

  if (!messages?.length) return;

  const messageText = messages.map(m => `${m.role === 'user' ? 'Creator' : 'Builder'}: ${m.content.substring(0, 200)}`).join('\n');

  const response = await anthropic.messages.create({
    model, max_tokens: 500, temperature: 0,
    system: 'Summarize these builder conversation messages in 4-6 sentences. Capture: what features were discussed or built, what design decisions were made and why, specific preferences or language the creator used, and any context that would help understand these decisions later. Be specific — include names, colors, numbers, and reasoning, not just "a decision was made."',
    messages: [{ role: 'user', content: messageText }],
  });

  const summary = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();
  const embedding = await generateEmbedding(summary);

  const { data: inserted } = await supabase.from('builder_summaries').insert({
    session_id: session.id, level: 1, content: summary,
    message_range_start: startSeq, message_range_end: endSeq,
    embedding: JSON.stringify(embedding),
  }).select().single();

  // Summary quality sampling: every 50th chunk, store original messages for evaluation
  if (inserted) {
    const { count } = await supabase
      .from('builder_summaries')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', session.id)
      .eq('level', 1);

    if ((count || 0) % 50 === 0) {
      await sampleSummaryQuality(session.id, inserted.id, messages, summary, model);
    }
  }
}

async function maybeCreateSectionSummary(session: BuilderSession, sectionsPerRollup: number, model: string): Promise<void> {
  const { data: unrolledChunks } = await supabase
    .from('builder_summaries')
    .select('*')
    .eq('session_id', session.id).eq('level', 1)
    .is('parent_summary_id', null)
    .order('message_range_start', { ascending: true });

  if (!unrolledChunks || unrolledChunks.length < sectionsPerRollup) return;

  const batch = unrolledChunks.slice(0, sectionsPerRollup);
  const response = await anthropic.messages.create({
    model, max_tokens: 500, temperature: 0,
    system: 'Combine these conversation summaries into a higher-level summary covering this building phase. In 4-6 sentences, capture the most important decisions and their reasoning, features built, and creator preferences. Preserve specific details like names, colors, and numbers where they matter.',
    messages: [{ role: 'user', content: batch.map(c => c.content).join('\n\n') }],
  });

  const summary = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();
  const embedding = await generateEmbedding(summary);

  const { data: sectionSummary } = await supabase.from('builder_summaries').insert({
    session_id: session.id, level: 2, content: summary,
    message_range_start: batch[0].message_range_start,
    message_range_end: batch[batch.length - 1].message_range_end,
    embedding: JSON.stringify(embedding),
  }).select().single();

  if (sectionSummary) {
    await supabase.from('builder_summaries')
      .update({ parent_summary_id: sectionSummary.id })
      .in('id', batch.map(c => c.id));
  }
}

async function maybeCreateEraSummary(session: BuilderSession, erasPerRollup: number, model: string): Promise<void> {
  const { data: unrolledSections } = await supabase
    .from('builder_summaries')
    .select('*')
    .eq('session_id', session.id).eq('level', 2)
    .is('parent_summary_id', null)
    .order('message_range_start', { ascending: true });

  if (!unrolledSections || unrolledSections.length < erasPerRollup) return;

  const batch = unrolledSections.slice(0, erasPerRollup);
  const response = await anthropic.messages.create({
    model, max_tokens: 400, temperature: 0,
    system: 'Compress these building phase summaries into a high-level era summary. In 3-4 sentences, capture the most important decisions, turning points, and architectural choices. Focus on information that would be essential context for understanding the app months later.',
    messages: [{ role: 'user', content: batch.map(s => s.content).join('\n\n') }],
  });

  const summary = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('\n').trim();
  const embedding = await generateEmbedding(summary);

  const { data: eraSummary } = await supabase.from('builder_summaries').insert({
    session_id: session.id, level: 3, content: summary,
    message_range_start: batch[0].message_range_start,
    message_range_end: batch[batch.length - 1].message_range_end,
    embedding: JSON.stringify(embedding),
  }).select().single();

  if (eraSummary) {
    await supabase.from('builder_summaries')
      .update({ parent_summary_id: eraSummary.id })
      .in('id', batch.map(s => s.id));
  }
}

// ---- Summary Quality Sampling ----

/**
 * Store the original messages alongside a summary for quality evaluation.
 * A cheap Haiku call scores how well the summary captures the originals.
 */
async function sampleSummaryQuality(
  sessionId: string,
  summaryId: string,
  originalMessages: Array<{ role: string; content: string }>,
  summaryContent: string,
  model: string
): Promise<void> {
  // Store the sample first (score comes async)
  const { data: sample } = await supabase.from('builder_summary_samples').insert({
    session_id: sessionId,
    summary_id: summaryId,
    original_messages: originalMessages,
    summary_content: summaryContent,
  }).select().single();

  if (!sample) return;

  // Score the summary quality
  const messagesText = originalMessages
    .map(m => `${m.role === 'user' ? 'Creator' : 'Builder'}: ${m.content.substring(0, 300)}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model,
    max_tokens: 300,
    temperature: 0,
    system: 'You evaluate summary quality. Given original messages and a summary, score 1-5: 1 = missed critical info, 3 = captured main points but lost nuance, 5 = excellent compression with key details and reasoning preserved. Return ONLY JSON: {"score": N, "notes": "what was captured well or missed"}',
    messages: [{
      role: 'user',
      content: `Original messages:\n${messagesText}\n\nSummary:\n${summaryContent}`,
    }],
  });

  const responseText = response.content.filter(b => b.type === 'text').map(b => (b as any).text).join('').trim();

  try {
    const parsed = JSON.parse(responseText.replace(/```json|```/g, '').trim());
    await supabase.from('builder_summary_samples')
      .update({ quality_score: parsed.score, quality_notes: parsed.notes })
      .eq('id', sample.id);
  } catch (e) {
    console.error('Failed to parse summary quality score:', e);
  }
}
