import { RawLLMResponse } from './llmCaller';

export interface ParsedResponse {
  conversationText: string;
  codeUpdate: { label: string; files: Record<string, string>; testData: any; previewDisplay: any } | null;
  requestedFiles: string[] | null;
}

export function v1StandardResponseParser(response: RawLLMResponse): ParsedResponse {
  const fullText = response.fullText;

  // File requests
  const fileRequestMatch = fullText.match(/<pelko_request_files>([\s\S]*?)<\/pelko_request_files>/);
  let requestedFiles: string[] | null = null;
  if (fileRequestMatch) {
    try { requestedFiles = JSON.parse(fileRequestMatch[1].trim()); } catch {}
  }

  // Code update
  const codeMatch = fullText.match(/<pelko_code>([\s\S]*?)<\/pelko_code>/);
  let codeUpdate: ParsedResponse['codeUpdate'] = null;
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
    }
  }

  const conversationText = fullText
    .replace(/<pelko_code>[\s\S]*?<\/pelko_code>/g, '')
    .replace(/<pelko_request_files>[\s\S]*?<\/pelko_request_files>/g, '')
    .trim();

  return { conversationText, codeUpdate, requestedFiles };
}
