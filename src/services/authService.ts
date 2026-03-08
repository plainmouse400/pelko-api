import { supabase } from '../config/supabase';
import { AuthUser } from '../types';

// Find or create a user by phone number within a specific app
export async function findOrCreateUserByPhone(appId: string, phone: string): Promise<{ user: AuthUser; isNewUser: boolean }> {
  // Try to find existing user
  const { data: existing } = await supabase
    .from('auth_users')
    .select('*')
    .eq('app_id', appId)
    .eq('phone', phone)
    .single();

  if (existing) {
    // Update last login
    await supabase
      .from('auth_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', existing.id);

    return { user: existing, isNewUser: false };
  }

  // Create new user
  const { data: newUser, error } = await supabase
    .from('auth_users')
    .insert({
      app_id: appId,
      phone,
      phone_verified: true, // verified via code
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create user: ${error.message}`);
  return { user: newUser!, isNewUser: true };
}

// Find or create a user by email within a specific app
export async function findOrCreateUserByEmail(appId: string, email: string): Promise<{ user: AuthUser; isNewUser: boolean }> {
  const { data: existing } = await supabase
    .from('auth_users')
    .select('*')
    .eq('app_id', appId)
    .eq('email', email.toLowerCase())
    .single();

  if (existing) {
    await supabase
      .from('auth_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', existing.id);

    return { user: existing, isNewUser: false };
  }

  const { data: newUser, error } = await supabase
    .from('auth_users')
    .insert({
      app_id: appId,
      email: email.toLowerCase(),
      email_verified: true,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create user: ${error.message}`);
  return { user: newUser!, isNewUser: true };
}

// Find or create a user by social provider within a specific app
export async function findOrCreateUserBySocial(
  appId: string,
  provider: 'apple' | 'google',
  providerUserId: string,
  email: string | null,
  name: string | null,
  avatarUrl: string | null
): Promise<{ user: AuthUser; isNewUser: boolean }> {
  // Check if this provider account is already linked
  const { data: existingProvider } = await supabase
    .from('auth_providers')
    .select('user_id')
    .eq('app_id', appId)
    .eq('provider', provider)
    .eq('provider_user_id', providerUserId)
    .single();

  if (existingProvider) {
    // Known social account — load the user
    const { data: user } = await supabase
      .from('auth_users')
      .select('*')
      .eq('id', existingProvider.user_id)
      .single();

    await supabase
      .from('auth_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', user!.id);

    return { user: user!, isNewUser: false };
  }

  // Check if there's an existing user with this email in this app
  // If so, link the social provider to that account
  if (email) {
    const { data: existingByEmail } = await supabase
      .from('auth_users')
      .select('*')
      .eq('app_id', appId)
      .eq('email', email.toLowerCase())
      .single();

    if (existingByEmail) {
      // Link social provider to existing account
      await supabase.from('auth_providers').insert({
        user_id: existingByEmail.id,
        app_id: appId,
        provider,
        provider_user_id: providerUserId,
        provider_email: email,
      });

      return { user: existingByEmail, isNewUser: false };
    }
  }

  // Brand new user — create account + link provider
  const { data: newUser, error } = await supabase
    .from('auth_users')
    .insert({
      app_id: appId,
      email: email?.toLowerCase(),
      email_verified: !!email, // email from Apple/Google is pre-verified
      display_name: name,
      avatar_url: avatarUrl,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create user: ${error.message}`);

  await supabase.from('auth_providers').insert({
    user_id: newUser!.id,
    app_id: appId,
    provider,
    provider_user_id: providerUserId,
    provider_email: email,
  });

  return { user: newUser!, isNewUser: true };
}

// Delete all user data for account deletion
export async function deleteUser(userId: string, appId: string): Promise<void> {
  // Delete in order: providers, sessions, then user
  await supabase.from('auth_providers').delete().eq('user_id', userId).eq('app_id', appId);
  await supabase.from('auth_sessions').delete().eq('user_id', userId).eq('app_id', appId);
  await supabase.from('auth_users').delete().eq('id', userId).eq('app_id', appId);

  // Note: micro app data in Firestore should be cleaned up separately
  // via a Cloud Function triggered by this deletion
}
