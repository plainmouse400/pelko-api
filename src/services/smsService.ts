import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

// Fallback: send verification code via SMS (costs ~$0.008 per message)
export async function sendCodeViaSMS(phone: string, code: string): Promise<void> {
  await client.messages.create({
    body: `Your Pelko verification code is: ${code}`,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
  });
}
