export function createTelegram(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env, or use --dry-run.');
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid TELEGRAM_BOT_TOKEN format in .env.');

  return async text => {
    // Exactly one request. Never expose the URL (it contains the bot token),
    // follow redirects, retry failures, or replay an uncertain delivery.
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.ok === true && Number.isInteger(body.result?.message_id)) {
        return { status: 'sent', messageId: body.result.message_id };
      }
      return {
        status: body?.ok === false ? 'failed' : 'uncertain',
        httpStatus: response.status,
        errorCode: Number.isInteger(body?.error_code) ? body.error_code : null,
      };
    } catch {
      return { status: 'uncertain', reason: 'network-error-or-timeout' };
    }
  };
}
