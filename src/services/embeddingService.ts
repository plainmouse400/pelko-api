import { supabase } from '../config/supabase';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';

export async function generateEmbedding(
  text: string,
  model: string = 'voyage-3-large',
  inputType: 'document' | 'query' = 'document'
): Promise<number[]> {
  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: [text], input_type: inputType }),
  });

  if (!response.ok) {
    throw new Error(`Voyage embedding API error: ${response.status}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

export async function searchMemory(
  sessionId: string,
  queryText: string,
  maxResults: number = 5,
  similarityThreshold: number = 0.7
): Promise<Array<{ id: string; level: number; content: string; similarity: number }>> {
  // Use input_type 'query' for search queries (vs 'document' for stored summaries)
  const queryEmbedding = await generateEmbedding(queryText, 'voyage-3-large', 'query');

  const { data, error } = await supabase.rpc('search_summaries', {
    p_session_id: sessionId,
    p_query_embedding: queryEmbedding,
    p_max_results: maxResults,
    p_similarity_threshold: similarityThreshold,
  });

  if (error) {
    console.error('Vector search error:', error);
    return [];
  }

  return data || [];
}
