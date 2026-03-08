import { supabase } from '../config/supabase';

// Send a verification code via push notification to the Pelko shell
// Returns true if push was sent, false if no device found (need SMS fallback)
export async function sendCodeViaPush(phone: string, code: string): Promise<boolean> {
  // Look up device registered with this phone number
  const { data: device, error } = await supabase
    .from('pelko_devices')
    .select('*')
    .eq('phone', phone)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !device) {
    return false; // No device found, caller should fall back to SMS
  }

  // Send push via APNs/FCM
  if (device.platform === 'ios') {
    await sendAPNS(device.device_token, {
      title: 'Verification Code',
      body: `Your code is: ${code}`,
      data: { type: 'verification_code', code },
    });
  } else {
    await sendFCM(device.device_token, {
      title: 'Verification Code',
      body: `Your code is: ${code}`,
      data: { type: 'verification_code', code },
    });
  }

  return true;
}

// Placeholder — implement with node-apn
async function sendAPNS(deviceToken: string, payload: { title: string; body: string; data: Record<string, string> }): Promise<void> {
  // TODO: Implement with node-apn library
  // const apnProvider = new apn.Provider({ ... });
  // const notification = new apn.Notification();
  // notification.alert = { title: payload.title, body: payload.body };
  // notification.payload = payload.data;
  // await apnProvider.send(notification, deviceToken);
  console.log(`[APNS] Sending to ${deviceToken}:`, payload);
}

// Placeholder — implement with firebase-admin
async function sendFCM(deviceToken: string, payload: { title: string; body: string; data: Record<string, string> }): Promise<void> {
  // TODO: Implement with firebase-admin messaging
  // await firebaseAdmin.messaging().send({
  //   token: deviceToken,
  //   notification: { title: payload.title, body: payload.body },
  //   data: payload.data,
  // });
  console.log(`[FCM] Sending to ${deviceToken}:`, payload);
}
