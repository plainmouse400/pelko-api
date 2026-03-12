import crypto from 'crypto';

interface TicketEntry {
  userId: string;
  appId: string;
  expiresAt: number;
}

// In-memory store. Tickets live for 30 seconds max and are single-use.
// TODO: Move to Redis when scaling to multiple instances.
const tickets = new Map<string, TicketEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (now > entry.expiresAt) tickets.delete(key);
  }
}, 60_000);

export function createTicket(userId: string, appId: string): string {
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { userId, appId, expiresAt: Date.now() + 30_000 });
  return ticket;
}

export function redeemTicket(ticket: string): { userId: string; appId: string } | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tickets.delete(ticket);
    return null;
  }
  tickets.delete(ticket); // Single-use
  return { userId: entry.userId, appId: entry.appId };
}
