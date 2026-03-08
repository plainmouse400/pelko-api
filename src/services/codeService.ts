import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { supabase } from '../config/supabase';

// Generate a random 6-digit code
export function generateCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

// Store a hashed verification code
export async function storeCode(appId: string, target: string, targetType: 'phone' | 'email'): Promise<string> {
  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);

  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + 5); // 5 minute expiry

  // Delete any existing codes for this target in this app
  await supabase
    .from('auth_verification_codes')
    .delete()
    .eq('app_id', appId)
    .eq('target', target)
    .eq('target_type', targetType);

  // Insert new code
  await supabase.from('auth_verification_codes').insert({
    app_id: appId,
    target,
    target_type: targetType,
    code_hash: codeHash,
    expires_at: expiresAt.toISOString(),
  });

  return code; // Return plain code to send to user
}

// Validate a verification code
export async function validateCode(
  appId: string,
  target: string,
  targetType: 'phone' | 'email',
  code: string
): Promise<{ valid: boolean; error?: string }> {
  const { data: record, error } = await supabase
    .from('auth_verification_codes')
    .select('*')
    .eq('app_id', appId)
    .eq('target', target)
    .eq('target_type', targetType)
    .single();

  if (error || !record) {
    return { valid: false, error: 'No verification code found. Request a new one.' };
  }

  // Check expiry
  if (new Date(record.expires_at) < new Date()) {
    await supabase.from('auth_verification_codes').delete().eq('id', record.id);
    return { valid: false, error: 'Code expired. Request a new one.' };
  }

  // Check attempts
  if (record.attempts >= 3) {
    await supabase.from('auth_verification_codes').delete().eq('id', record.id);
    return { valid: false, error: 'Too many wrong attempts. Request a new code.' };
  }

  // Verify code
  const isValid = await bcrypt.compare(code, record.code_hash);

  if (!isValid) {
    // Increment attempts
    await supabase
      .from('auth_verification_codes')
      .update({ attempts: record.attempts + 1 })
      .eq('id', record.id);
    return { valid: false, error: 'Invalid code.' };
  }

  // Code is valid — delete it (one-time use)
  await supabase.from('auth_verification_codes').delete().eq('id', record.id);
  return { valid: true };
}
