import { supabase } from '../config/supabase';

interface BuilderVariant {
  id: string;
  name: string;
  parent_name: string | null;
  config_overrides: Record<string, any>;
  weight: number;
  is_default: boolean;
  active: boolean;
}

export async function resolveVariantConfig(variantId: string): Promise<Record<string, any>> {
  const { data: variant } = await supabase
    .from('builder_variants')
    .select('*')
    .eq('id', variantId)
    .single();

  if (!variant) throw new Error(`Variant ${variantId} not found`);

  if (!variant.parent_name) {
    return variant.config_overrides;
  }

  const { data: parent } = await supabase
    .from('builder_variants')
    .select('*')
    .eq('name', variant.parent_name)
    .single();

  if (!parent) throw new Error(`Parent variant ${variant.parent_name} not found`);

  const parentConfig = await resolveVariantConfig(parent.id);
  return deepMerge(parentConfig, variant.config_overrides);
}

function deepMerge(base: Record<string, any>, overrides: Record<string, any>): Record<string, any> {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    if (
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof overrides[key] === 'object' && overrides[key] !== null && !Array.isArray(overrides[key])
    ) {
      result[key] = { ...result[key], ...overrides[key] };
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

export async function assignVariant(): Promise<BuilderVariant> {
  const { data: variants } = await supabase
    .from('builder_variants')
    .select('*')
    .eq('active', true)
    .gt('weight', 0);

  if (!variants || variants.length === 0) {
    const { data: defaultVariant } = await supabase
      .from('builder_variants')
      .select('*')
      .eq('is_default', true)
      .single();
    if (!defaultVariant) throw new Error('No default variant configured');
    return defaultVariant;
  }

  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  let random = Math.random() * totalWeight;
  for (const variant of variants) {
    random -= variant.weight;
    if (random <= 0) return variant;
  }
  return variants[variants.length - 1];
}
