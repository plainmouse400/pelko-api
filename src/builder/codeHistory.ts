import { supabase } from '../config/supabase';

interface CodeMessage {
  sequenceNumber: number;
  codeUpdate: {
    label: string;
    files: Record<string, string>;
    testData: any;
    previewDisplay: any;
  };
}

async function getCodeMessages(sessionId: string): Promise<CodeMessage[]> {
  const { data: messages } = await supabase
    .from('builder_messages')
    .select('sequence_number, code_update')
    .eq('session_id', sessionId)
    .not('code_update', 'is', null)
    .order('sequence_number', { ascending: true });

  return (messages || []).map(m => ({
    sequenceNumber: m.sequence_number,
    codeUpdate: m.code_update,
  }));
}

function reconstructCodeAtStep(
  codeMessages: CodeMessage[],
  stepIndex: number
): { currentCode: Record<string, string>; testData: any; previewDisplay: any } {
  const merged: Record<string, string> = {};
  let testData: any = null;
  let previewDisplay: any = null;

  for (let i = 0; i <= stepIndex; i++) {
    const update = codeMessages[i].codeUpdate;
    Object.assign(merged, update.files);
    if (update.testData) testData = update.testData;
    if (update.previewDisplay) previewDisplay = update.previewDisplay;
  }

  return { currentCode: merged, testData, previewDisplay };
}

export async function getSessionState(userId: string, appId: string) {
  const { data: session } = await supabase
    .from('builder_sessions')
    .select('*')
    .eq('app_id', appId)
    .eq('user_id', userId)
    .single();

  if (!session) {
    return {
      messages: [],
      currentCode: {},
      messageCount: 0,
      undoDepth: 0,
      redoDepth: 0,
    };
  }

  const { data: messages } = await supabase
    .from('builder_messages')
    .select('*')
    .eq('session_id', session.id)
    .order('sequence_number', { ascending: true });

  const codeMessages = (messages || []).filter(m => m.code_update !== null);
  const totalCodeSteps = codeMessages.length;
  const pointer = session.code_pointer ?? totalCodeSteps - 1;

  return {
    messages: (messages || []).map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      codeUpdate: m.code_update,
      sequenceNumber: m.sequence_number,
      createdAt: m.created_at,
    })),
    currentCode: session.current_code || {},
    messageCount: session.message_count || 0,
    undoDepth: totalCodeSteps > 0 ? pointer : 0,
    redoDepth: totalCodeSteps > 0 ? totalCodeSteps - 1 - pointer : 0,
  };
}

export async function getUndoRedoDepths(sessionId: string): Promise<{ undoDepth: number; redoDepth: number }> {
  const { data: session } = await supabase
    .from('builder_sessions')
    .select('code_pointer')
    .eq('id', sessionId)
    .single();

  const { count } = await supabase
    .from('builder_messages')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .not('code_update', 'is', null);

  const totalCodeSteps = count || 0;
  const pointer = session?.code_pointer ?? totalCodeSteps - 1;

  return {
    undoDepth: totalCodeSteps > 0 ? pointer : 0,
    redoDepth: totalCodeSteps > 0 ? totalCodeSteps - 1 - pointer : 0,
  };
}

export async function moveCodePointer(
  userId: string,
  appId: string,
  direction: 'undo' | 'redo'
): Promise<{
  currentCode: Record<string, string>;
  testData: any;
  previewDisplay: any;
  undoDepth: number;
  redoDepth: number;
  revertedLabels: string[];
} | null> {
  const { data: session } = await supabase
    .from('builder_sessions')
    .select('*')
    .eq('app_id', appId)
    .eq('user_id', userId)
    .single();

  if (!session) return null;

  const codeMessages = await getCodeMessages(session.id);
  if (codeMessages.length === 0) return null;

  let pointer = session.code_pointer ?? codeMessages.length - 1;

  if (direction === 'undo' && pointer > 0) {
    pointer--;
  } else if (direction === 'redo' && pointer < codeMessages.length - 1) {
    pointer++;
  } else {
    return null; // Already at limit
  }

  const state = reconstructCodeAtStep(codeMessages, pointer);

  // Labels of steps ahead of the pointer (the reverted work)
  const revertedLabels = codeMessages
    .slice(pointer + 1)
    .map(m => m.codeUpdate.label)
    .filter(Boolean);

  await supabase
    .from('builder_sessions')
    .update({
      code_pointer: pointer,
      current_code: state.currentCode,
      reverted_labels: revertedLabels.length > 0 ? revertedLabels : null,
    })
    .eq('id', session.id);

  const totalCodeSteps = codeMessages.length;

  return {
    currentCode: state.currentCode,
    testData: state.testData,
    previewDisplay: state.previewDisplay,
    undoDepth: pointer,
    redoDepth: totalCodeSteps - 1 - pointer,
    revertedLabels,
  };
}
