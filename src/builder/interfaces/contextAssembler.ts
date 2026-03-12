import { BuilderSession, getRecentMessages, getAppBrief } from '../../services/sessionService';
import { searchMemory } from '../../services/embeddingService';
import { BUILDER_SYSTEM_PROMPT } from '../../prompts/builderSystem';

export interface FullContext {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextTokenEstimate: number;
  filesIncluded: string[];
  memoriesRetrieved: number;
  retrievedMemoryDetails: Array<{ id: string; level: number; content: string; similarity: number }>;
}

export async function v1HybridContextAssembler(
  session: BuilderSession,
  creatorMessage: string
): Promise<FullContext> {
  const config = session.resolvedConfig;
  const assemblerConfig = config.contextAssemblerConfig || {};

  // 1. System prompt
  let systemPrompt = config.systemPrompt;
  if (!systemPrompt || systemPrompt === '__BUILDER_SYSTEM_PROMPT__') {
    systemPrompt = BUILDER_SYSTEM_PROMPT;
  }

  // 2. App Brief
  if (config.includeAppBrief) {
    const brief = await getAppBrief(session.id);
    if (brief) {
      systemPrompt += `\n\n## App Brief\n${brief}`;
    }
  }

  // 3. File Index
  if (config.includeFileIndex && session.fileIndex.length > 0) {
    systemPrompt += `\n\n## Files in this app\n`;
    for (const file of session.fileIndex) {
      systemPrompt += `- ${file.filename} [${file.keywords.join(', ')}] — ${file.description}\n`;
    }
    systemPrompt += `\nIf you need to see a file not included below, output:\n<pelko_request_files>["filename1.tsx", "filename2.tsx"]</pelko_request_files>\nI'll provide the full content and you can continue.\n`;
  }

  // 4. Relevant file contents
  const filesIncluded = selectRelevantFiles(
    creatorMessage,
    session.fileIndex,
    session.currentCode,
    config.maxFilesFullContent || 4,
    assemblerConfig.fileSelectionMethod || 'keyword'
  );

  if (filesIncluded.length > 0) {
    systemPrompt += `\n\n## Current Code (relevant files)\n`;
    for (const filename of filesIncluded) {
      const code = session.currentCode[filename];
      if (code) {
        systemPrompt += `\n### ${filename}\n\`\`\`tsx\n${code}\n\`\`\`\n`;
      }
    }
  }

  // 4b. Reverted labels (set when the creator has undone code changes)
  if (session.revertedLabels && session.revertedLabels.length > 0) {
    systemPrompt += `\n\n## Recently Reverted Changes\n`;
    systemPrompt += `The creator rolled back the app. These changes are no longer in the current code:\n`;
    for (const label of session.revertedLabels) {
      systemPrompt += `- ${label}\n`;
    }
    systemPrompt += `\nThis is context for when you next generate code. Do NOT proactively mention these reverted changes in conversation — only consider them when you are about to write new code. At that point, if it seems like the creator may not realize they lost functionality that is relevant to what they are asking for, briefly ask if they want to preserve any of it. If the creator's intent is clear and they obviously know what they rolled back, just proceed without asking.\n`;
  }

  // 5. Retrieved memory summaries
  let memoriesRetrieved = 0;
  let retrievedMemoryDetails: Array<{ id: string; level: number; content: string; similarity: number }> = [];
  if (assemblerConfig.vectorSearchEnabled && session.messageCount > (config.recentMessageCount || 8)) {
    try {
      const memories = await searchMemory(
        session.id,
        creatorMessage,
        config.maxRetrievedMemoryChunks || 5,
        assemblerConfig.similarityThreshold || 0.7
      );

      if (memories.length > 0) {
        systemPrompt += `\n\n## Relevant History\n`;
        for (const memory of memories) {
          const levelLabel = memory.level === 1 ? 'Recent' : memory.level === 2 ? 'Earlier' : 'Early';
          systemPrompt += `[${levelLabel}] ${memory.content}\n\n`;
        }
        memoriesRetrieved = memories.length;
        retrievedMemoryDetails = memories;
      }
    } catch (err) {
      console.error('Memory search failed (non-blocking):', err);
    }
  }

  // 6. Recent messages + current message
  const recentMessages = await getRecentMessages(session.id, config.recentMessageCount || 8);
  const messages = [...recentMessages, { role: 'user' as const, content: creatorMessage }];

  const contextTokenEstimate = Math.ceil(
    (systemPrompt.length + messages.reduce((sum, m) => sum + m.content.length, 0)) / 4
  );

  return { system: systemPrompt, messages, contextTokenEstimate, filesIncluded, memoriesRetrieved, retrievedMemoryDetails };
}

function selectRelevantFiles(
  message: string,
  fileIndex: Array<{ filename: string; keywords: string[]; description: string }>,
  currentCode: Record<string, string>,
  maxFiles: number,
  method: string
): string[] {
  if (Object.keys(currentCode).length <= maxFiles) {
    return Object.keys(currentCode);
  }
  if (method === 'all') {
    return Object.keys(currentCode);
  }

  const messageWords = message.toLowerCase().split(/\s+/);
  const scored = fileIndex.map(file => {
    const allFileWords = [
      ...file.keywords.map(k => k.toLowerCase()),
      ...file.description.toLowerCase().split(/\s+/),
      file.filename.toLowerCase(),
    ];
    let score = 0;
    for (const word of messageWords) {
      if (allFileWords.some(fw => fw.includes(word) || word.includes(fw))) score++;
    }
    return { filename: file.filename, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxFiles).filter(f => currentCode[f.filename]).map(f => f.filename);

  if (selected.length === 0 && Object.keys(currentCode).length > 0) {
    selected.push(Object.keys(currentCode)[0]);
  }

  return selected;
}
