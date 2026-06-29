// ════════════════════════════════════════════════════════════
//  /api/quotes.js  —  Vercel 서버리스 함수 (팀 공유 견적 저장소)
//  Upstash Redis(무료)를 사용해 팀원 전체가 같은 견적 History를 공유합니다.
//
//  ▸ 환경변수 2개 필요 (Vercel에 자동 주입됨 — Upstash 연결 시):
//      KV_REST_API_URL
//      KV_REST_API_TOKEN
//  ▸ GET    /api/quotes        → 전체 견적 목록 조회
//  ▸ POST   /api/quotes        → 견적 1건 저장(추가/수정)
//  ▸ DELETE /api/quotes?id=... → 견적 1건 삭제
//  ▸ PUT    /api/quotes        → 견적 상태 변경 {id, status}
// ════════════════════════════════════════════════════════════

const KEY = 'lgl:quotes';  // Redis 해시 키 (id → JSON)

function getEnv() {
  // Vercel이 Upstash 연결 시 KV_REST_API_* 또는 UPSTASH_REDIS_REST_* 로 주입
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    '';
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    '';
  return { url, token };
}

// Upstash REST API 호출 (단일 명령)
async function redis(command) {
  const { url, token } = getEnv();
  if (!url || !token) {
    throw new Error('DB가 연결되지 않았습니다. Vercel에서 Upstash(KV) 연동 후 환경변수를 확인하세요.');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Redis 오류 (${res.status}): ${t.slice(0, 150)}`);
  }
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── 전체 조회 ──
    if (req.method === 'GET') {
      const all = await redis(['HGETALL', KEY]); // [field, value, field, value, ...]
      const quotes = [];
      if (Array.isArray(all)) {
        for (let i = 1; i < all.length; i += 2) {
          try { quotes.push(JSON.parse(all[i])); } catch (_) {}
        }
      }
      // 저장일 최신순 정렬
      quotes.sort((a, b) => (b.savedAtTs || 0) - (a.savedAtTs || 0));
      return res.status(200).json({ quotes });
    }

    // ── 저장(추가/수정) ──
    if (req.method === 'POST') {
      const q = req.body || {};
      if (!q.id) return res.status(400).json({ error: 'id가 필요합니다.' });
      if (!q.savedAtTs) q.savedAtTs = Date.now();
      await redis(['HSET', KEY, String(q.id), JSON.stringify(q)]);
      return res.status(200).json({ ok: true, id: q.id });
    }

    // ── 상태 변경 ──
    if (req.method === 'PUT') {
      const { id, status } = req.body || {};
      if (!id || !status) return res.status(400).json({ error: 'id와 status가 필요합니다.' });
      const cur = await redis(['HGET', KEY, String(id)]);
      if (!cur) return res.status(404).json({ error: '해당 견적을 찾을 수 없습니다.' });
      const q = JSON.parse(cur);
      q.status = status;
      await redis(['HSET', KEY, String(id), JSON.stringify(q)]);
      return res.status(200).json({ ok: true });
    }

    // ── 삭제 ──
    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || '';
      if (!id) return res.status(400).json({ error: 'id가 필요합니다.' });
      await redis(['HDEL', KEY, String(id)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: '지원하지 않는 메서드입니다.' });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err).slice(0, 300) });
  }
}
