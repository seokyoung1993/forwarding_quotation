// ════════════════════════════════════════════════════════════
//  /api/insight.js  —  Vercel 서버리스 함수 (Google Gemini 무료 API)
//  화주용 시황 코멘트 생성 (Gemini + 구글 검색 Grounding 프록시)
//
//  ▸ API 키는 Vercel 환경변수(GEMINI_API_KEY)에 저장됩니다.
//  ▸ 429(요청 과다) 발생 시 여러 모델로 자동 재시도합니다.
// ════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // ── CORS 허용 ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 요청만 허용됩니다.' });

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: '서버에 Gemini API 키가 설정되지 않았습니다. Vercel 환경변수(GEMINI_API_KEY)를 확인하세요.' });
  }

  try {
    const {
      keywords = '',
      pol = '',
      pod = '',
      mode = 'sea',
      tone = 'polite',
      surcharges = [],
    } = req.body || {};

    if (!keywords.trim()) {
      return res.status(400).json({ error: '검색 키워드를 입력해주세요.' });
    }

    const toneGuide = {
      polite: '정중하고 양해를 구하는 어조. 운임 인상이 불가피했음을 공손히 설명하고 이해를 부탁하는 톤.',
      info:   '객관적이고 중립적인 정보 제공 어조. 시황을 사실 위주로 담담하게 전달하는 톤.',
      urgent: '신속한 의사결정을 유도하는 어조. 운임 변동성과 선복 부족을 강조하여 조속한 부킹 확정을 권유하는 톤.',
    }[tone] || '정중한 어조';

    const modeLabel = mode === 'air' ? '항공' : '해상';
    const routeStr  = (pol && pod) ? `${pol} → ${pod}` : '해당';
    const surStr    = surcharges.length ? surcharges.join(', ') : '없음';

    const prompt = `당신은 롯데글로벌로지스의 베테랑 포워딩 영업 담당자입니다.
화주(고객사)에게 ${modeLabel} 운송 견적서를 송부하면서, 메일 본문에 함께 넣을 "시황 안내 코멘트"를 작성해야 합니다.

[견적 정보]
- 운송 모드: ${modeLabel}
- 구간: ${routeStr}
- 견적서에 포함된 할증료: ${surStr}
- 영업 담당자가 입력한 시황 키워드: "${keywords}"

[작성 지침]
1. 위 키워드와 관련된 최신 물류/운임 시황을 반영해 사실에 근거해 작성하세요.
2. ${toneGuide}
3. 화주에게 바로 보낼 수 있는 한국어 비즈니스 메일 본문 형태로 작성하세요.
4. 분량은 4~6문장 내외로 간결하게. 과장하지 말고 신뢰감 있게.
5. 구체적 수치(유가 $, 지수 등)는 확실한 경우에만 신중히 인용하고, 불확실하면 정성적으로 표현하세요.
6. 인사말로 시작해서, 시황 설명 → (해당 시 운임 영향) → 마무리 순으로 작성하세요.
7. 메일 본문만 출력하세요. 제목이나 설명, 부연, 마크다운 기호는 넣지 마세요.`;

    // ── 시도할 모델 목록 (429 시 순서대로 폴백) ──
    const MODELS = [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash-lite',
      'gemini-flash-latest',
    ];

    let lastErr = '';
    let lastStatus = 0;

    for (const model of MODELS) {
      // 검색 도구 포함 호출 → 실패 시 검색 없이도 재시도
      for (const useSearch of [true, false]) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
        const body = {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        };
        if (useSearch) body.tools = [{ google_search: {} }];

        let r;
        try {
          r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        } catch (e) {
          lastErr = String(e); lastStatus = 0;
          continue;
        }

        if (r.ok) {
          const data = await r.json();
          const text = (data.candidates?.[0]?.content?.parts || [])
            .map(p => p.text || '').join('\n').trim();
          if (text) {
            return res.status(200).json({ comment: text, _model: model, _search: useSearch });
          }
          lastErr = '응답이 비어있음'; lastStatus = 502;
          continue;
        }

        // 실패 — 상태/메시지 기록
        lastStatus = r.status;
        lastErr = (await r.text()).slice(0, 200);

        // 429(과다요청)/503(혼잡)이면 다음 모델로, 그 외 오류면 검색 토글만 한 번 더 시도
        if (r.status !== 429 && r.status !== 503 && r.status !== 500) {
          // 검색 끄고 재시도할 가치가 있는 건 useSearch=true였을 때뿐
          if (!useSearch) break;
        }
      }
    }

    // 모든 모델 실패
    return res.status(lastStatus || 502).json({
      error: lastStatus === 429
        ? '현재 무료 사용량 한도에 도달했습니다. 1~2분 후 다시 시도해주세요.'
        : `Gemini API 오류 (${lastStatus})`,
      detail: lastErr,
    });

  } catch (err) {
    return res.status(500).json({ error: '서버 처리 중 오류', detail: String(err).slice(0, 300) });
  }
}
