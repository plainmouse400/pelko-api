import { supabase } from '../config/supabase';
import { assignVariant, resolveVariantConfig } from './variantService';

export interface BuilderSession {
  id: string;
  userId: string;
  appId: string;
  variantId: string;
  resolvedConfig: Record<string, any>;
  currentCode: Record<string, string>;
  fileIndex: Array<{ filename: string; keywords: string[]; description: string }>;
  messageCount: number;
  codePointer: number | null;
  revertedLabels: string[] | null;
}

export interface BuilderMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  codeUpdate: any | null;
  sequenceNumber: number;
  createdAt: string;
}

export async function getOrCreateSession(userId: string, appId: string): Promise<BuilderSession> {
  const { data: existing } = await supabase
    .from('builder_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('app_id', appId)
    .single();

  if (existing) {
    await supabase
      .from('builder_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', existing.id);

    return {
      id: existing.id,
      userId: existing.user_id,
      appId: existing.app_id,
      variantId: existing.variant_id,
      resolvedConfig: existing.resolved_config,
      currentCode: existing.current_code,
      fileIndex: existing.file_index,
      messageCount: existing.message_count,
      codePointer: existing.code_pointer ?? null,
      revertedLabels: existing.reverted_labels ?? null,
    };
  }

  const variant = await assignVariant();
  const resolvedConfig = await resolveVariantConfig(variant.id);

  const { data: newSession, error } = await supabase
    .from('builder_sessions')
    .insert({
      user_id: userId,
      app_id: appId,
      variant_id: variant.id,
      resolved_config: resolvedConfig,
      current_code: {},
      file_index: [],
      message_count: 0,
    })
    .select()
    .single();

  if (error || !newSession) throw new Error(`Failed to create session: ${error?.message}`);

  return {
    id: newSession.id,
    userId: newSession.user_id,
    appId: newSession.app_id,
    variantId: newSession.variant_id,
    resolvedConfig: newSession.resolved_config,
    currentCode: newSession.current_code,
    fileIndex: newSession.file_index,
    messageCount: newSession.message_count,
    codePointer: null,
    revertedLabels: null,
  };
}

export async function getSessionMessages(sessionId: string): Promise<BuilderMessage[]> {
  const { data } = await supabase
    .from('builder_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: true });

  return (data || []).map(msg => ({
    id: msg.id,
    role: msg.role,
    content: msg.content,
    codeUpdate: msg.code_update,
    sequenceNumber: msg.sequence_number,
    createdAt: msg.created_at,
  }));
}

export async function getRecentMessages(
  sessionId: string,
  count: number
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { data } = await supabase
    .from('builder_messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('sequence_number', { ascending: false })
    .limit(count);

  return (data || []).reverse().map(msg => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content,
  }));
}

export async function storeMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  codeUpdate: any | null,
  tokenUsage: { inputTokens: number; outputTokens: number } | null
): Promise<void> {
  const { data: session } = await supabase
    .from('builder_sessions')
    .select('message_count')
    .eq('id', sessionId)
    .single();

  const sequenceNumber = (session?.message_count || 0) + 1;

  await supabase.from('builder_messages').insert({
    session_id: sessionId,
    role,
    content,
    code_update: codeUpdate,
    token_usage: tokenUsage,
    sequence_number: sequenceNumber,
  });

  const updates: Record<string, any> = {
    message_count: sequenceNumber,
    last_active_at: new Date().toISOString(),
  };

  if (codeUpdate?.files) {
    const { data: currentSession } = await supabase
      .from('builder_sessions')
      .select('current_code')
      .eq('id', sessionId)
      .single();

    updates.current_code = {
      ...(currentSession?.current_code || {}),
      ...codeUpdate.files,
    };
  }

  await supabase.from('builder_sessions').update(updates).eq('id', sessionId);
}

export async function getAppBrief(sessionId: string): Promise<string | null> {
  const { data } = await supabase
    .from('builder_app_briefs')
    .select('content')
    .eq('session_id', sessionId)
    .single();

  return data?.content || null;
}

export async function updateAppBrief(
  sessionId: string,
  appId: string,
  content: string
): Promise<void> {
  const { data: existing } = await supabase
    .from('builder_app_briefs')
    .select('id, version')
    .eq('session_id', sessionId)
    .single();

  if (existing) {
    await supabase
      .from('builder_app_briefs')
      .update({ content, version: existing.version + 1, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await supabase.from('builder_app_briefs').insert({
      session_id: sessionId,
      app_id: appId,
      content,
      version: 1,
    });
  }
}
