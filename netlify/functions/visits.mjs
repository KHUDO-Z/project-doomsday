// Счётчик уникальных посетителей PROJECT DOOMSDAY.
// Работает целиком на Netlify: Netlify Functions + Netlify Blobs, без сторонних сервисов.
//
//   GET  /api/visits            → { count }
//   POST /api/visits  { id }    → { count, new }   (id — UUID браузера из localStorage)
//
// Защита от накрутки:
//   • каждый id засчитывается один раз (атомарная запись onlyIfNew);
//   • с одного IP — не больше NEW_PER_IP_PER_DAY новых посетителей в сутки;
//   • IP не хранится: только его SHA-256 с секретной солью.

import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';

export const config = { path: '/api/visits' };

const STORE_NAME = 'doomsday-visits';
const COUNT_KEY = 'count';
const SALT_KEY = 'meta/salt';
const NEW_PER_IP_PER_DAY = 10;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function readCount(store) {
    const data = await store.get(COUNT_KEY, { type: 'json' });
    return (data && Number.isFinite(data.value)) ? data.value : 0;
}

// Атомарный +1: читаем вместе с ETag и пишем только если значение никто не успел поменять.
export async function increment(store) {
    for (let attempt = 0; attempt < 12; attempt++) {
        const current = await store.getWithMetadata(COUNT_KEY, { type: 'json' });
        if (!current) {
            const { modified } = await store.setJSON(COUNT_KEY, { value: 1 }, { onlyIfNew: true });
            if (modified) return 1;
        } else {
            const next = ((current.data && current.data.value) || 0) + 1;
            const { modified } = await store.setJSON(COUNT_KEY, { value: next }, { onlyIfMatch: current.etag });
            if (modified) return next;
        }
        await sleep(15 + Math.random() * 40 * (attempt + 1));   // кто-то записал одновременно — повторяем
    }
    throw new Error('Не удалось обновить счётчик: слишком много одновременных записей');
}

async function getSalt(store) {
    const existing = await store.get(SALT_KEY);
    if (existing) return existing;
    await store.set(SALT_KEY, randomBytes(32).toString('hex'), { onlyIfNew: true });
    return store.get(SALT_KEY);
}

// Лимит новых посетителей с одного IP за сутки. Небольшая гонка тут допустима: это защита, а не учёт.
async function allowNewFromIp(store, ip) {
    if (!ip) return true;
    const salt = await getSalt(store);
    const ipHash = createHash('sha256').update(salt + ip).digest('hex').slice(0, 32);
    const day = new Date().toISOString().slice(0, 10);
    const key = `rate/${day}/${ipHash}`;
    const used = Number(await store.get(key)) || 0;
    if (used >= NEW_PER_IP_PER_DAY) return false;
    await store.set(key, String(used + 1));
    return true;
}

export async function handle(req, context, store) {
    if (req.method === 'GET') {
        return json({ count: await readCount(store) });
    }

    if (req.method !== 'POST') {
        return json({ error: 'Метод не поддерживается' }, 405);
    }

    let id = null;
    try { ({ id } = await req.json()); } catch { /* пустое или битое тело */ }
    if (typeof id !== 'string' || !ID_RE.test(id)) {
        return json({ error: 'Некорректный id' }, 400);
    }

    const visitorKey = `visitor/${id.toLowerCase()}`;
    if (await store.get(visitorKey) !== null) {
        return json({ count: await readCount(store), new: false });    // уже засчитан
    }

    if (!(await allowNewFromIp(store, context && context.ip))) {
        return json({ count: await readCount(store), new: false, limited: true });
    }

    const { modified } = await store.set(visitorKey, new Date().toISOString(), { onlyIfNew: true });
    const count = modified ? await increment(store) : await readCount(store);
    return json({ count, new: modified });
}

export default async (req, context) => {
    try {
        const store = getStore({ name: STORE_NAME, consistency: 'strong' });
        return await handle(req, context, store);
    } catch (err) {
        console.error(err);
        return json({ error: 'Счётчик временно недоступен' }, 500);
    }
};
