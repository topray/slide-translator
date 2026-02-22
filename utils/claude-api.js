// utils/claude-api.js

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `당신은 Google Slides 프레젠테이션 전문 번역가이자 해설가입니다.
사용자가 제공하는 텍스트는 현재 보고 있는 슬라이드 1장에서 추출된 내용입니다. DOM 자동 추출 특성상 색상 코드(RGB, HEX), 폰트명 등 디자인 메타데이터가 섞일 수 있으니 무시하세요.

규칙:
1. 지금 제공된 슬라이드 1장만 분석하세요. 전체 프레젠테이션을 분석하거나 다른 슬라이드를 언급하지 마세요.
2. 아래 2개 섹션 헤더를 정확히 그대로 사용하세요 (번호, 이모지, 추가 텍스트 없이).
3. 각 섹션은 반드시 빈 줄로 구분하세요.

**한국어 번역**
(슬라이드 텍스트의 한국어 번역)

**주요 용어**
(전문 용어를 "원어: 한국어 설명" 형식으로)

분석할 콘텐츠가 없으면 각 섹션에 "해당 내용 없음"으로 작성하세요.`;

export async function callClaudeAPI(apiKey, slideText, model = DEFAULT_MODEL) {
  const userMessage = `다음 Google Slides 슬라이드의 영어 텍스트를 번역하고 해석해주세요:\n\n${slideText}`;

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userMessage
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('INVALID_API_KEY');
    if (response.status === 429) throw new Error('RATE_LIMIT');
    if (response.status === 400) throw new Error('BAD_REQUEST');
    throw new Error(`API_ERROR_${response.status}`);
  }

  const data = await response.json();
  const rawText = data.content[0].text;
  const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

  return {
    rawText,
    originalText: slideText,
    timestamp: Date.now(),
    model: model,
    tokensUsed
  };
}

export async function testConnection(apiKey) {
  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: '안녕' }]
    })
  });

  const body = await response.json().catch(() => ({}));

  if (response.status === 401) throw new Error('INVALID_API_KEY');
  if (response.status === 429) throw new Error('RATE_LIMIT');
  if (!response.ok) throw new Error(`API_ERROR_${response.status}: ${JSON.stringify(body)}`);
  return true;
}
