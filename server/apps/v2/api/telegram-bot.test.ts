import { describe, expect, it } from 'vitest';
import {
  type BotFetch,
  type BotResponse,
  LONG_POLL_SECONDS,
  TelegramApiError,
  TelegramBot,
} from './telegram-bot.js';

const TOKEN = '123456789:AAH-test-token-abcdefghijklmnop';

interface Call {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

function scripted(...responses: (BotResponse | Error)[]): { fetchImpl: BotFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: BotFetch = (url, init) => {
    calls.push({
      url,
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal,
    });
    const next = responses.shift() ?? new Error('script exhausted');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetchImpl, calls };
}

function answer(body: unknown, status = 200): BotResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe('TelegramBot.getUpdates', () => {
  it('long-polls for messages only and returns the updates', async () => {
    const { fetchImpl, calls } = scripted(
      answer({ ok: true, result: [{ update_id: 7, message: { text: 'halt' } }] }),
    );
    const updates = await new TelegramBot(TOKEN, fetchImpl).getUpdates(
      undefined,
      new AbortController().signal,
    );
    expect(updates).toEqual([{ update_id: 7, message: { text: 'halt' } }]);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
    expect(calls[0]?.body).toEqual({ timeout: LONG_POLL_SECONDS, allowed_updates: ['message'] });
  });

  it('acknowledges everything before the offset it is given', async () => {
    const { fetchImpl, calls } = scripted(answer({ ok: true, result: [] }));
    await new TelegramBot(TOKEN, fetchImpl).getUpdates(42, new AbortController().signal);
    expect(calls[0]?.body.offset).toBe(42);
  });

  it('drops entries that are not updates', async () => {
    const { fetchImpl } = scripted(
      answer({ ok: true, result: [null, 'x', {}, { update_id: 'a' }, { update_id: 3 }] }),
    );
    const updates = await new TelegramBot(TOKEN, fetchImpl).getUpdates(
      undefined,
      new AbortController().signal,
    );
    expect(updates).toEqual([{ update_id: 3 }]);
  });

  it('refuses a body with no result list', async () => {
    const { fetchImpl } = scripted(answer({ ok: false }));
    await expect(
      new TelegramBot(TOKEN, fetchImpl).getUpdates(undefined, new AbortController().signal),
    ).rejects.toThrow(/no result list/);
  });

  it('names the status of a refusal, such as 409 from a second poller', async () => {
    const { fetchImpl } = scripted(answer({}, 409));
    await expect(
      new TelegramBot(TOKEN, fetchImpl).getUpdates(undefined, new AbortController().signal),
    ).rejects.toThrow('Telegram getUpdates answered 409');
  });

  it('never carries the bot token in a thrown error, even when fetch puts the URL in its own', async () => {
    const { fetchImpl } = scripted(
      new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/getUpdates`),
    );
    const failure = await new TelegramBot(TOKEN, fetchImpl)
      .getUpdates(undefined, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramApiError);
    expect((failure as Error).message).toBe('Telegram getUpdates did not complete');
    expect(String((failure as Error).stack)).not.toContain(TOKEN);
  });

  it('aborts the request when shutdown fires', async () => {
    const { fetchImpl, calls } = scripted(answer({ ok: true, result: [] }));
    const controller = new AbortController();
    await new TelegramBot(TOKEN, fetchImpl).getUpdates(undefined, controller.signal);
    expect(calls[0]?.signal.aborted).toBe(false);
    controller.abort();
    expect(calls[0]?.signal.aborted).toBe(true);
  });
});

describe('TelegramBot.sendMessage', () => {
  it('posts the text to the chat', async () => {
    const { fetchImpl, calls } = scripted(answer({ ok: true }));
    await new TelegramBot(TOKEN, fetchImpl).sendMessage(55, 'hello');
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.body).toEqual({ chat_id: 55, text: 'hello' });
  });

  it('masks credentials and stays under the 4096 character limit', async () => {
    const { fetchImpl, calls } = scripted(answer({ ok: true }));
    await new TelegramBot(TOKEN, fetchImpl).sendMessage(55, `token=${TOKEN} ${'x'.repeat(9_000)}`);
    const text = String(calls[0]?.body.text);
    expect(text).not.toContain('AAH-test-token');
    expect(text.length).toBeLessThan(4_096);
  });

  it('throws a token-free error when Telegram refuses', async () => {
    const { fetchImpl } = scripted(answer({}, 400));
    await expect(new TelegramBot(TOKEN, fetchImpl).sendMessage(55, 'x')).rejects.toThrow(
      'Telegram sendMessage answered 400',
    );
  });
});
