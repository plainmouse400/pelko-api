import { supabase } from '../config/supabase';

// Current pricing (update as needed)
const PRICING = {
  'claude-sonnet-4-20250514': {
    inputPerMillion: 3.00,    // $3.00 per million input tokens
    outputPerMillion: 15.00,  // $15.00 per million output tokens
  },
};

interface UsageRecord {
  userId: string;
  appId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  interactionType: string;
}

export async function trackUsage(record: UsageRecord): Promise<void> {
  const pricing = PRICING[record.model as keyof typeof PRICING];
  const costCents = pricing
    ? (record.tokensIn / 1_000_000) * pricing.inputPerMillion * 100
      + (record.tokensOut / 1_000_000) * pricing.outputPerMillion * 100
    : 0;

  await supabase.from('builder_usage').insert({
    user_id: record.userId,
    app_id: record.appId,
    model: record.model,
    tokens_in: record.tokensIn,
    tokens_out: record.tokensOut,
    cost_cents: costCents,
    interaction_type: record.interactionType,
  });
}

export async function getUserUsageToday(userId: string): Promise<{
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostCents: number;
  interactionCount: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('builder_usage')
    .select('tokens_in, tokens_out, cost_cents')
    .eq('user_id', userId)
    .gte('created_at', today.toISOString());

  if (!data || data.length === 0) {
    return { totalTokensIn: 0, totalTokensOut: 0, totalCostCents: 0, interactionCount: 0 };
  }

  return {
    totalTokensIn: data.reduce((sum, r) => sum + r.tokens_in, 0),
    totalTokensOut: data.reduce((sum, r) => sum + r.tokens_out, 0),
    totalCostCents: data.reduce((sum, r) => sum + Number(r.cost_cents), 0),
    interactionCount: data.length,
  };
}
