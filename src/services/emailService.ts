import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

// Send verification code via email
export async function sendCodeViaEmail(email: string, code: string, appName: string): Promise<void> {
  await resend.emails.send({
    from: 'Pelko <verify@pelko.ai>',
    to: email,
    subject: `Your ${appName} verification code`,
    html: `
      <h2>Your verification code</h2>
      <p>Enter this code to sign in to ${appName}:</p>
      <h1 style="letter-spacing: 8px; font-size: 36px;">${code}</h1>
      <p>This code expires in 5 minutes.</p>
      <p style="color: #999; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}
