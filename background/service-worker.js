// background/service-worker.js
// MV3 Service Worker - handles API calls and state persistence

import { callClaudeAPI, testConnection } from '../utils/claude-api.js';

// In-memory translation cache (lost on service worker restart, that's acceptable)
const translationCache = new Map();

// __DEV_START__
// ─── 개발 모드: 파일 변경 시 자동 리로드 ────────────────────────────────────
// npm run dev 실행 시 WebSocket 서버(localhost:7788)에 연결해 reload 신호 수신

(function connectDevServer() {
  const WS_URL = 'ws://localhost:7788';
  let ws = null;
  let retryTimer = null;

  function connect() {
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => console.log('[Dev] 개발 서버 연결됨 — 파일 변경 시 자동 리로드');
      ws.onmessage = (e) => {
        if (e.data === 'reload') {
          console.log('[Dev] 리로드 신호 수신 → chrome.runtime.reload()');
          chrome.runtime.reload();
        }
      };
      ws.onclose = () => {
        ws = null;
        // 5초 후 재연결 시도 (개발 서버가 재시작될 수 있음)
        retryTimer = setTimeout(connect, 5000);
      };
      ws.onerror = () => {}; // 개발 서버 없을 때 에러 무시
    } catch {}
  }

  connect();
})();
// __DEV_END__

// ─── 확장 아이콘 클릭 → 독립 창 열기 ─────────────────────────────────────────

const POPUP_URL = chrome.runtime.getURL('popup/popup.html');
const POPUP_DEFAULT_WIDTH = 460;
const POPUP_DEFAULT_HEIGHT = 680;

// 팝업 창 ID 추적 (창 이동/리사이즈 감지용)
let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  // 이미 열린 창이 있으면 포커스만
  const existing = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
  for (const win of existing) {
    const match = win.tabs?.find(t => t.url?.startsWith(POPUP_URL));
    if (match) {
      await chrome.windows.update(win.id, { focused: true });
      popupWindowId = win.id;
      return;
    }
  }

  // 저장된 위치/크기 불러오기
  const stored = await chrome.storage.local.get(['popupBounds']);
  const bounds = stored.popupBounds || {};

  // 새 독립 창으로 열기 (저장된 위치가 화면 밖이면 무시)
  const createOpts = {
    url: POPUP_URL,
    type: 'popup',
    width:  bounds.width  || POPUP_DEFAULT_WIDTH,
    height: bounds.height || POPUP_DEFAULT_HEIGHT,
    focused: true
  };
  if (bounds.left !== undefined && bounds.top !== undefined) {
    createOpts.left = bounds.left;
    createOpts.top = bounds.top;
  }

  try {
    const win = await chrome.windows.create(createOpts);
    popupWindowId = win.id;
  } catch {
    // 저장된 위치가 화면 밖일 경우 위치 없이 재시도
    await chrome.storage.local.remove('popupBounds');
    const win = await chrome.windows.create({
      url: POPUP_URL,
      type: 'popup',
      width: POPUP_DEFAULT_WIDTH,
      height: POPUP_DEFAULT_HEIGHT,
      focused: true
    });
    popupWindowId = win.id;
  }
});

// 창 이동/리사이즈 시 위치 저장
chrome.windows.onBoundsChanged.addListener(async (win) => {
  if (win.id !== popupWindowId) return;
  if (win.state === 'minimized' || win.state === 'maximized' || win.state === 'fullscreen') return;
  await chrome.storage.local.set({
    popupBounds: {
      left:   win.left,
      top:    win.top,
      width:  win.width,
      height: win.height
    }
  });
});

// 창 닫힐 때 ID 초기화
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SLIDE_TEXT') {
    // content script sender의 tabId를 주입 (메시지에 없을 경우 대비)
    if (!message.tabId && sender.tab?.id) {
      message.tabId = sender.tab.id;
    }
    handleSlideText(message);
    return false;
  }

  if (message.type === 'GET_SLIDE_INFO') {
    // scripting API로 직접 읽기 — content script 준비 여부 무관하게 항상 동작
    chrome.scripting.executeScript({
      target: { tabId: message.tabId, frameIds: [0] },
      func: () => {
        const slideId = (window.location.hash.match(/slide=id\.([\w\d_]+)/) || [])[1] || null;

        let slideNumber = null;
        if (slideId) {
          const thumbnails = Array.from(document.querySelectorAll('.punch-filmstrip-thumbnail'));
          const idx = thumbnails.findIndex(el => el.innerHTML.includes(slideId));
          if (idx >= 0) {
            const pageNumEl = thumbnails[idx].querySelector('.punch-filmstrip-thumbnail-pagenumber');
            const parsed = parseInt(pageNumEl?.textContent, 10);
            slideNumber = isNaN(parsed) ? null : parsed;
          }
        }
        return { slideId, slideNumber };
      }
    })
      .then(results => sendResponse({ success: true, ...results[0].result }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'EXTRACT_FROM_TAB') {
    // popup이 직접 추출을 요청 → service worker가 scripting API로 추출 후 번역
    extractAndTranslate(message.tabId)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === 'GET_LAST_RESULT') {
    chrome.storage.local.get(['lastResult', 'status']).then(data => {
      sendResponse({ result: data.lastResult, status: data.status });
    });
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    translationCache.clear();
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'TEST_API_KEY') {
    testConnection(message.apiKey)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, code: e.message || 'API_ERROR' }));
    return true;
  }
});

// ─── Service Worker 직접 추출 (content script context 문제 우회) ──────────────

async function extractAndTranslate(tabId) {
  // scripting API로 탭에서 직접 텍스트 추출 (메인 프레임만)
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      const slideId = (() => {
        const m = window.location.hash.match(/slide=id\.([\w\d_]+)/);
        return m ? m[1] : null;
      })();

      const slideEl = slideId
        ? document.querySelector(`[id="editor-${slideId}"]`) || document.querySelector(`[id$="-${slideId}"]`)
        : null;
      const textParts = [];

      const scope = slideEl || document;
      scope.querySelectorAll('svg text').forEach(el => {
        if (!slideEl && el.closest('[id^="editor-p"]')) {
          const ancestor = el.closest('[id^="editor-p"]');
          if (ancestor && ancestor.id !== `editor-${slideId}`) return;
        }
        const t = el.textContent.trim();
        if (t.length >= 1) textParts.push(t);
      });

      const text = textParts.filter(t => t.length > 0).join('\n');

      let slideNumber = null;
      if (slideId) {
        const thumbnails = Array.from(document.querySelectorAll('.punch-filmstrip-thumbnail'));
        const idx = thumbnails.findIndex(el => el.innerHTML.includes(slideId));
        if (idx >= 0) {
          const pageNumEl = thumbnails[idx].querySelector('.punch-filmstrip-thumbnail-pagenumber');
          const parsed = parseInt(pageNumEl?.textContent, 10);
          slideNumber = isNaN(parsed) ? null : parsed;
        }
      }

      return { text, slideId: slideId || 'unknown', slideNumber: slideNumber || null };
    }
  });

  const { text, slideId, slideNumber } = results[0].result;
  if (!text || text.trim().length < 5) {
    await chrome.storage.local.set({ status: 'error', lastError: 'NO_TEXT_FOUND' });
    throw new Error('NO_TEXT_FOUND');
  }

  // 텍스트 추출 완료 → 팝업에 extracting 단계 알림
  const storedModel = await chrome.storage.local.get(['selectedModel']);
  const model = storedModel.selectedModel || 'claude-sonnet-4-6';
  broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'loading', slideNumber, stage: 'extracting', textLength: text.length, model });

  await handleSlideText({ text, slideId, slideNumber, tabId, manual: true });
}

// ─── Slide Text Processing ────────────────────────────────────────────────────

async function handleSlideText(message) {
  const { text, slideId, slideNumber = null, tabId, manual = false } = message;

  const stored = await chrome.storage.local.get(['claudeApiKey', 'selectedModel', 'slideStates']);

  if (!stored.claudeApiKey) {
    await setSlideState(slideId, { status: 'error', error: 'NO_API_KEY', slideNumber });
    broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'error', error: 'NO_API_KEY', slideNumber });
    return;
  }

  const currentState = stored.slideStates?.[slideId];

  // 이미 로딩 중인 슬라이드 중복 요청 무시
  if (!manual && currentState?.status === 'loading') return;

  const cacheKey = slideId + ':' + simpleHash(text);

  // 캐시 히트 — 즉시 결과 반환
  if (translationCache.has(cacheKey)) {
    const cached = translationCache.get(cacheKey);
    const result = { ...cached, tabId, fromCache: true };
    await setSlideState(slideId, { status: 'ready', slideNumber, result });
    broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'ready', slideNumber, result });
    return;
  }

  // 수동 요청이 아니면 → idle로 알림만 (자동 번역 없음)
  if (!manual) {
    // 이미 ready/loading 상태면 그 상태 유지 (슬라이드 재방문 시)
    if (currentState?.status === 'ready' || currentState?.status === 'loading') {
      broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, ...currentState, slideNumber });
      return;
    }
    // 새 슬라이드거나 idle/error → idle로 알림
    await setSlideState(slideId, { status: 'idle', slideNumber });
    broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'idle', slideNumber });
    return;
  }

  // 번역 시작 (수동 요청)
  const model = stored.selectedModel || 'claude-sonnet-4-6';

  await setSlideState(slideId, { status: 'loading', slideNumber });
  // stage: 'translating' — 텍스트 추출은 이미 완료, API 호출 시작
  broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'loading', slideNumber, stage: 'translating', textLength: text.length, model });

  try {
    const result = await callClaudeAPI(stored.claudeApiKey, text, model);
    const resultWithTab = { ...result, tabId };

    // 인-메모리 캐시 저장
    if (translationCache.size >= 50) {
      translationCache.delete(translationCache.keys().next().value);
    }
    translationCache.set(cacheKey, result);

    await setSlideState(slideId, { status: 'ready', slideNumber, result: resultWithTab });
    broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'ready', slideNumber, result: resultWithTab });

  } catch (error) {
    const code = error.message || 'API_ERROR';
    await setSlideState(slideId, { status: 'error', slideNumber, error: code });
    broadcastToPopup({ type: 'SLIDE_STATE', slideId, tabId, status: 'error', slideNumber, error: code });
  }
}

// ─── slideId별 상태 저장 (최대 100개 유지) ────────────────────────────────────

async function setSlideState(slideId, state) {
  const stored = await chrome.storage.local.get(['slideStates']);
  const slideStates = stored.slideStates || {};
  slideStates[slideId] = { ...state, updatedAt: Date.now() };

  // 최대 100개 유지 (오래된 것부터 삭제)
  const entries = Object.entries(slideStates);
  if (entries.length > 100) {
    entries.sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
    delete slideStates[entries[0][0]];
  }

  await chrome.storage.local.set({ slideStates });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcastToPopup(data) {
  chrome.runtime.sendMessage(data).catch(() => {
    // Popup may not be open — that's fine, result is persisted in storage
  });
}

function simpleHash(text) {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 500); i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
