// popup/popup.js

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initializePopup();
  } catch (e) {
    console.error('[SlideTranslator] initializePopup error:', e);
    showView('idle');
    updateStatus('idle', '번역 버튼을 눌러 현재 슬라이드를 번역하세요');
  }
  setupEventListeners();
  listenForUpdates();
  listenForTabChanges();
});

// ─── 슬라이드 탭 유틸 ────────────────────────────────────────────────────────

function isSlidesUrl(url) {
  return !!(url && (
    url.includes('docs.google.com/presentation') ||
    url.includes('slides.google.com')
  ));
}

async function findSlidesTab() {
  const allTabs = await chrome.tabs.query({});
  const slidesTabs = allTabs.filter(t => isSlidesUrl(t.url));
  if (slidesTabs.length === 0) return null;

  const anyActive = slidesTabs.find(t => t.active);
  if (anyActive) return anyActive;

  slidesTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return slidesTabs[0];
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function initializePopup() {
  // 1순위: storage에 저장된 마지막 슬라이드 탭 (팝업 창이 열리면 active 탭이 바뀌므로)
  // 2순위: 현재 active 탭 또는 lastAccessed 기준
  const { currentSlidesTabId } = await chrome.storage.local.get(['currentSlidesTabId']);
  let tab = null;

  if (currentSlidesTabId) {
    tab = await chrome.tabs.get(currentSlidesTabId).catch(() => null);
    if (tab && !isSlidesUrl(tab.url)) tab = null; // 슬라이드가 아니면 무시
  }

  if (!tab) {
    tab = await findSlidesTab();
  }

  if (!tab) {
    showView('notSlides');
    updateTabTitle(null);
    return;
  }

  updateTabTitle(tab);
  await chrome.storage.local.set({ currentSlidesTabId: tab.id });

  const stored = await chrome.storage.local.get(['claudeApiKey', 'slideStates', 'currentSlideId']);

  if (!stored.claudeApiKey) {
    showView('noApiKey');
    return;
  }

  // service worker(scripting API)로 현재 슬라이드 정보 가져오기 — 항상 동작
  try {
    const info = await chrome.runtime.sendMessage({ type: 'GET_SLIDE_INFO', tabId: tab.id });
    if (info?.success && info.slideId) {
      await chrome.storage.local.set({ currentSlideId: info.slideId });
      applySlideState(stored.slideStates, info.slideId, info.slideNumber);
      return;
    }
  } catch (_) { /* 무시 */ }

  // 실패 시 이전 상태만 복원
  const fallbackSlideId = stored.currentSlideId || null;
  applySlideState(stored.slideStates, fallbackSlideId, null);
}

// ─── View Management ──────────────────────────────────────────────────────────

const VIEW_IDS = {
  notSlides: 'notSlidesWarning',
  noApiKey:  'noApiKeyWarning',
  idle:      'idleState',
  loading:   'loadingState',
  main:      'mainContent',
  error:     'errorState'
};

function showView(viewName) {
  Object.values(VIEW_IDS).forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  if (VIEW_IDS[viewName]) {
    document.getElementById(VIEW_IDS[viewName])?.classList.remove('hidden');
  }
  if (viewName === 'loading') {
    startLoadingTimer();
  } else {
    stopLoadingTimer();
  }
}

function updateStatus(type, message) {
  const bar = document.getElementById('statusBar');
  const text = document.getElementById('statusText');
  bar.className = 'status-bar status-' + type;
  text.textContent = message;
}

// ─── Loading 상세 정보 ────────────────────────────────────────────────────────

let _loadingTimerInterval = null;
let _loadingStartTime = null;

function startLoadingTimer() {
  // 이미 타이머가 실행 중이면 리셋하지 않음 (stage 전환 시 유지)
  if (_loadingTimerInterval) return;
  _loadingStartTime = Date.now();
  const timerEl = document.getElementById('loadingTimer');
  if (timerEl) timerEl.textContent = '0초';

  _loadingTimerInterval = setInterval(() => {
    if (!_loadingStartTime) return;
    const sec = Math.floor((Date.now() - _loadingStartTime) / 1000);
    if (timerEl) timerEl.textContent = `${sec}초`;
  }, 1000);
}

function stopLoadingTimer() {
  if (_loadingTimerInterval) {
    clearInterval(_loadingTimerInterval);
    _loadingTimerInterval = null;
  }
  _loadingStartTime = null;
}

function updateLoadingInfo(stage, textLength, model) {
  const stageEl = document.getElementById('loadingStage');
  const detailEl = document.getElementById('loadingDetail');

  if (stageEl) {
    if (stage === 'extracting') stageEl.textContent = '텍스트 추출';
    else if (stage === 'translating') stageEl.textContent = 'AI 번역 중';
    else stageEl.textContent = '';
  }

  const parts = [];
  if (textLength) parts.push(`약 ${textLength.toLocaleString()}자`);
  if (model) {
    // claude-sonnet-4-6 → Sonnet 4.6
    const modelShort = model
      .replace('claude-', '')
      .replace(/(sonnet|opus|haiku)/i, m => m.charAt(0).toUpperCase() + m.slice(1));
    parts.push(modelShort);
  }
  if (detailEl) detailEl.textContent = parts.join(' · ');
}

function slidePageLabel(slideNumber) {
  if (slideNumber) return `${slideNumber} 페이지`;
  return null;
}

// 현재 슬라이드 상태를 팝업 UI에 적용
function applySlideState(slideStates, slideId, liveSlideNumber, loadingMeta) {
  const state = slideId ? slideStates?.[slideId] : null;
  const pageLabel = slidePageLabel(liveSlideNumber ?? null);

  if (!state || state.status === 'idle') {
    showView('idle');
    updateStatus('idle', pageLabel ? `${pageLabel} · 번역 버튼을 눌러주세요` : '번역 버튼을 눌러 현재 슬라이드를 번역하세요');
  } else if (state.status === 'loading') {
    showView('loading');
    updateStatus('loading', pageLabel ? `${pageLabel} · 번역하고 있습니다...` : 'Claude AI가 번역하고 있습니다...');
    if (loadingMeta) {
      updateLoadingInfo(loadingMeta.stage, loadingMeta.textLength, loadingMeta.model);
    }
  } else if (state.status === 'ready' && state.result) {
    renderResult(state.result);
    showView('main');
    updateStatus('ready', pageLabel
      ? `${pageLabel} · ${state.result?.fromCache ? '번역 완료 (캐시)' : '번역 완료'}`
      : (state.result?.fromCache ? '번역 완료 (캐시)' : '번역 완료'));
  } else if (state.status === 'error') {
    showView('error');
    setErrorMessage(state.error || 'API_ERROR');
    updateStatus('error', pageLabel ? `${pageLabel} · 오류 발생` : '오류 발생');
  } else {
    showView('idle');
    updateStatus('idle', pageLabel ? `${pageLabel} · 번역 버튼을 눌러주세요` : '번역 버튼을 눌러 현재 슬라이드를 번역하세요');
  }
}

function updateTabTitle(tab) {
  const titleEl = document.getElementById('tabTitle');
  const subtitleEl = document.getElementById('tabSubtitle');
  if (!titleEl) return;

  if (!tab) {
    titleEl.textContent = '슬라이드 번역기';
    if (subtitleEl) subtitleEl.textContent = '';
    return;
  }

  const raw = tab.title || '';
  const clean = raw
    .replace(/\s*[-–]\s*Google (Slides|슬라이드)$/i, '')
    .replace(/\s*[-–]\s*Google Presentations?$/i, '')
    .trim();

  titleEl.textContent = clean || '슬라이드 번역기';
  if (subtitleEl) subtitleEl.textContent = clean ? '슬라이드 번역기' : '';
}

// ─── 탭 기준으로 팝업 상태 업데이트 ─────────────────────────────────────────

async function updatePopupForTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (!tab || !tab.url) return;
  if (tab.url.startsWith('chrome-extension://')) return;
  if (tab.url.startsWith('chrome://')) return;

  const isSlides = isSlidesUrl(tab.url);

  if (!isSlides) {
    const allTabs = await chrome.tabs.query({});
    const hasSlidesTab = allTabs.some(t => isSlidesUrl(t.url));
    if (!hasSlidesTab) {
      showView('notSlides');
      updateTabTitle(null);
    }
    return;
  }

  updateTabTitle(tab);
  await chrome.storage.local.set({ currentSlidesTabId: tabId });

  const stored = await chrome.storage.local.get(['claudeApiKey', 'slideStates']);

  if (!stored.claudeApiKey) {
    showView('noApiKey');
    return;
  }

  // service worker(scripting API)로 현재 슬라이드 정보 가져오기
  try {
    const info = await chrome.runtime.sendMessage({ type: 'GET_SLIDE_INFO', tabId });
    if (info?.success && info.slideId) {
      await chrome.storage.local.set({ currentSlideId: info.slideId });
      applySlideState(stored.slideStates, info.slideId, info.slideNumber);
      return;
    }
  } catch (_) { /* 무시 */ }

  applySlideState(stored.slideStates, null, null);
}

// ─── 번역 요청 공통 함수 ──────────────────────────────────────────────────────

async function requestTranslation() {
  const stored = await chrome.storage.local.get(['currentSlidesTabId']);
  let tabId = stored.currentSlidesTabId;

  if (!tabId) {
    const tab = await findSlidesTab();
    if (!tab) {
      showView('error');
      setErrorMessage('NO_TEXT_FOUND');
      return;
    }
    tabId = tab.id;
    await chrome.storage.local.set({ currentSlidesTabId: tabId });
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    showView('error');
    setErrorMessage('NO_TEXT_FOUND');
    return;
  }

  // 탭이 unloaded 상태면 활성화해서 로드될 때까지 대기
  if (tab.status === 'unloaded' || tab.discarded) {
    showView('loading');
    updateStatus('loading', '슬라이드 탭을 로드하고 있습니다...');
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(tid, info) {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
      setTimeout(resolve, 3000);
    });
  }

  showView('loading');
  updateStatus('loading', 'Claude AI가 번역하고 있습니다...');
  updateLoadingInfo('extracting', null, null);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXTRACT_FROM_TAB', tabId });
    if (!response?.success) {
      showView('error');
      setErrorMessage('NO_TEXT_FOUND');
      updateStatus('error', '텍스트를 찾을 수 없습니다');
    }
  } catch (e) {
    showView('error');
    setErrorMessage('NO_TEXT_FOUND');
    updateStatus('error', '텍스트를 찾을 수 없습니다');
  }
}

// ─── Result Rendering ─────────────────────────────────────────────────────────

function renderResult(result) {
  const sections = parseClaudeResponse(result.rawText);

  setText('originalText', result.originalText || '');
  setMarkdown('translationText', sections.translation || result.rawText);
  setMarkdown('keyTermsText', sections.keyTerms || '');

  if (result.timestamp) {
    const timeStr = new Date(result.timestamp).toLocaleTimeString('ko-KR', {
      hour: '2-digit', minute: '2-digit'
    });
    document.getElementById('lastUpdated').textContent = timeStr + ' 번역';
  }
  if (result.tokensUsed) {
    document.getElementById('tokenCount').textContent = result.tokensUsed.toLocaleString() + ' 토큰';
  }
}

function setText(elementId, text) {
  const el = document.getElementById(elementId);
  if (el) el.textContent = text;
}

function setMarkdown(elementId, text) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = renderMarkdown(text);
}

// ─── Markdown Helpers ─────────────────────────────────────────────────────────

function mdInlineFormat(str) {
  str = str.replace(/`([^`]+)`/g, '<code>$1</code>');
  str = str.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  str = str.replace(/__(.+?)__/g, '<strong>$1</strong>');
  str = str.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  str = str.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return str;
}

function renderMarkdown(text) {
  if (!text) return '';

  var lines = text.split('\n');
  var html = [];
  var inList = false;
  var inOlList = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trimEnd();

    if (line.trim() === '') {
      if (inList)   { html.push('</ul>'); inList = false; }
      if (inOlList) { html.push('</ol>'); inOlList = false; }
      continue;
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      if (inList)   { html.push('</ul>'); inList = false; }
      if (inOlList) { html.push('</ol>'); inOlList = false; }
      html.push('<hr>');
      continue;
    }

    var hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      if (inList)   { html.push('</ul>'); inList = false; }
      if (inOlList) { html.push('</ol>'); inOlList = false; }
      var level = hMatch[1].length;
      html.push('<h' + level + '>' + mdInlineFormat(hMatch[2]) + '</h' + level + '>');
      continue;
    }

    if (line.indexOf('> ') === 0) {
      if (inList)   { html.push('</ul>'); inList = false; }
      if (inOlList) { html.push('</ol>'); inOlList = false; }
      html.push('<blockquote>' + mdInlineFormat(line.slice(2)) + '</blockquote>');
      continue;
    }

    var olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (inList) { html.push('</ul>'); inList = false; }
      if (!inOlList) { html.push('<ol>'); inOlList = true; }
      html.push('<li>' + mdInlineFormat(olMatch[1]) + '</li>');
      continue;
    }

    var ulMatch = line.match(/^[•\-*+]\s+(.+)/);
    if (ulMatch) {
      if (inOlList) { html.push('</ol>'); inOlList = false; }
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push('<li>' + mdInlineFormat(ulMatch[1]) + '</li>');
      continue;
    }

    if (inList)   { html.push('</ul>'); inList = false; }
    if (inOlList) { html.push('</ol>'); inOlList = false; }
    html.push('<p>' + mdInlineFormat(line) + '</p>');
  }

  if (inList)   html.push('</ul>');
  if (inOlList) html.push('</ol>');

  return html.join('\n');
}

function parseClaudeResponse(text) {
  if (!text) return {};
  const sections = {};

  const markers = {
    translation:    /\*\*한국어\s*번역\*\*/,
    keyTerms:       /\*\*주요\s*용어\*\*/,
  };

  const positions = {};
  for (const [key, re] of Object.entries(markers)) {
    const m = text.match(re);
    if (m) positions[key] = m.index + m[0].length;
  }

  const order = ['translation', 'keyTerms'];
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (positions[key] === undefined) continue;
    const start = positions[key];
    const nextKey = order.slice(i + 1).find(k => positions[k] !== undefined);
    const end = nextKey ? text.match(markers[nextKey]).index : text.length;
    sections[key] = text.slice(start, end).trim();
  }

  return sections;
}

function setErrorMessage(code) {
  const messages = {
    'NO_API_KEY':     'API 키가 설정되지 않았습니다.\n설정 페이지에서 Claude API 키를 입력해주세요.',
    'INVALID_API_KEY':'API 키가 올바르지 않습니다.\n설정 페이지에서 키를 다시 확인해주세요.',
    'RATE_LIMIT':     'API 요청 한도를 초과했습니다.\n잠시 후 다시 시도해주세요.',
    'BAD_REQUEST':    '잘못된 요청입니다. 슬라이드 텍스트를 다시 확인해주세요.',
    'NO_TEXT_FOUND':  '이 슬라이드에서 텍스트를 찾을 수 없습니다.\n슬라이드에 텍스트가 있는지 확인해주세요.'
  };
  const el = document.getElementById('errorMessage');
  if (el) el.textContent = messages[code] || ('오류가 발생했습니다: ' + code);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function setupEventListeners() {
  document.getElementById('translateBtn')?.addEventListener('click', requestTranslation);
  document.getElementById('retranslateBtn')?.addEventListener('click', requestTranslation);

  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('goToSettingsBtn')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  document.getElementById('errorSettingsBtn')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('retryBtn')?.addEventListener('click', async () => {
    await chrome.storage.local.remove(['status', 'lastError']);
    showView('idle');
    updateStatus('idle', '번역 버튼을 눌러 현재 슬라이드를 번역하세요');
  });

  document.getElementById('originalToggle')?.addEventListener('click', () => {
    const content = document.getElementById('originalContent');
    const icon = document.querySelector('#originalToggle .toggle-icon');
    const isCollapsed = content.classList.toggle('collapsed');
    icon.textContent = isCollapsed ? '▶' : '▼';
  });

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      const text = el?.innerText;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const original = btn.textContent;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = original; }, 2000);
      });
    });
  });
}

// ─── Live Update Listener ─────────────────────────────────────────────────────

function listenForUpdates() {
  // service worker로부터 SLIDE_STATE 메시지 수신
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'SLIDE_STATE') return;

    // 현재 포커스된 슬라이드 탭의 메시지인지 확인
    chrome.storage.local.get(['currentSlidesTabId', 'slideStates']).then(data => {
      if (data.currentSlidesTabId && data.currentSlidesTabId !== message.tabId) return;

      // 현재 탭의 슬라이드 이동이므로 currentSlideId도 실시간 업데이트
      chrome.storage.local.set({ currentSlideId: message.slideId });

      // loading 상태는 storage 타이밍 문제를 피해 메시지 데이터로 직접 처리
      if (message.status === 'loading') {
        const pageLabel = slidePageLabel(message.slideNumber ?? null);
        showView('loading');
        updateStatus('loading', pageLabel ? `${pageLabel} · 번역하고 있습니다...` : 'Claude AI가 번역하고 있습니다...');
        updateLoadingInfo(message.stage, message.textLength, message.model);
        return;
      }

      const loadingMeta = null;
      applySlideState(data.slideStates, message.slideId, message.slideNumber ?? null, loadingMeta);
    });
  });
}

// ─── Tab Change Listener ───────────────────────────────────────────────────────

let ownTabId = null;

function listenForTabChanges() {
  chrome.tabs.getCurrent().then(tab => {
    if (tab) ownTabId = tab.id;
  });

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    if (activeInfo.tabId === ownTabId) return;
    await updatePopupForTab(activeInfo.tabId);
  });

  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;

    const tabs = await chrome.tabs.query({ active: true, windowId });
    const activeTab = tabs[0];
    if (!activeTab || activeTab.id === ownTabId) return;
    if (activeTab.url?.startsWith('chrome-extension://')) return;

    await updatePopupForTab(activeTab.id);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tabId === ownTabId) return;
    if (changeInfo.status !== 'complete') return;
    if (!tab.active) return;
    if (isSlidesUrl(tab.url) || isSlidesUrl(changeInfo.url)) {
      await updatePopupForTab(tabId);
    }
  });
}
