// content/content-script.js
// Injected into Google Slides pages to extract text and detect slide changes

(function () {
  'use strict';

  if (window.self !== window.top) return; // 메인 프레임에서만 실행

  let lastSlideId = null;
  let lastSentSlideId = null;  // 마지막으로 메시지를 보낸 슬라이드 ID
  let lastExtractedText = '';  // 마지막으로 보낸 텍스트 (같은 슬라이드 내 중복 방지용)
  let debounceTimer = null;
  let isInitialized = false;
  let isInvalidated = false;

  // ─── Slide ID (URL 해시에서 추출) ────────────────────────────────────────────

  function getCurrentSlideId() {
    const m = window.location.hash.match(/slide=id\.([\w\d_]+)/);
    return m ? m[1] : null;
  }

  // ─── 현재 슬라이드 DOM 요소 찾기 ─────────────────────────────────────────────
  // filmstrip-slide-{번호}-{slideId} 패턴으로 존재함

  function getCurrentSlideElement(slideId) {
    if (!slideId) return null;
    // 편집 캔버스 우선, fallback으로 id 끝 매칭
    return document.querySelector(`[id="editor-${slideId}"]`)
      || document.querySelector(`[id$="-${slideId}"]`);
  }

  // ─── 텍스트 추출 ──────────────────────────────────────────────────────────────

  function extractSlideText() {
    const slideId = getCurrentSlideId();
    const slideEl = getCurrentSlideElement(slideId);

    const scope = slideEl || document;
    const textParts = [];

    // <text> 요소 단위로 수집 (tspan은 text.textContent에 포함됨)
    scope.querySelectorAll('svg text').forEach(el => {
      // slideEl이 없을 때(document 전체)만 다른 슬라이드 UI 요소 제외
      // slideEl이 있으면 이미 해당 슬라이드 스코프이므로 필터 불필요
      if (!slideEl && el.closest('[id^="editor-p"]')) {
        // 단, 현재 슬라이드 ID가 p로 시작하는 경우는 제외하지 않음
        const ancestor = el.closest('[id^="editor-p"]');
        if (ancestor && ancestor.id !== `editor-${slideId}`) return;
      }
      const t = el.textContent.trim();
      if (t.length >= 1) textParts.push(t);
    });

    // 빈 항목 제거 후 합치기
    return textParts.filter(t => t.length > 0).join('\n');
  }

  // ─── 슬라이드 번호 추출 ──────────────────────────────────────────────────────

  function getSlidePageInfo(slideId) {
    // 현재 슬라이드 번호: thumbnail innerHTML에 현재 slideId가 포함된 항목 찾기
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
    return { slideNumber: slideNumber || null };
  }

  // ─── 슬라이드 변경 핸들러 ─────────────────────────────────────────────────────

  function onSlideChange() {
    const text = extractSlideText();
    if (!text || text.trim().length < 5) return;
    // 슬라이드가 바뀌지 않았고 텍스트도 같으면 중복 전송 방지 (같은 슬라이드 내 DOM 변경 시)
    // 슬라이드가 바뀐 경우(lastSentSlideId !== lastSlideId)는 텍스트가 같아도 항상 전송
    if (lastSentSlideId === lastSlideId && text === lastExtractedText) return;
    lastSentSlideId = lastSlideId;
    lastExtractedText = text;

    if (isInvalidated) return;
    try {
      const { slideNumber } = getSlidePageInfo(lastSlideId);
      chrome.runtime.sendMessage({
        type: 'SLIDE_TEXT',
        text: text,
        slideId: lastSlideId || 'unknown',
        slideNumber,
        url: window.location.href
      }, () => void chrome.runtime.lastError);
    } catch (e) {
      // Extension context invalidated — 조용히 종료
      isInvalidated = true;
    }
  }

  function debounceSlideChange(delay = 500) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onSlideChange, delay);
  }

  // ─── 초기화 ───────────────────────────────────────────────────────────────────

  function initSlideWatcher() {
    if (isInitialized) return;
    isInitialized = true;

    lastSlideId = getCurrentSlideId();

    // Google Slides는 history.replaceState()로 URL을 바꾸므로
    // hashchange / popstate / MutationObserver(aria-selected) 모두 발생하지 않음.
    // URL polling이 유일하게 신뢰할 수 있는 감지 방법.

    // Primary: URL polling (300ms 간격)
    setInterval(() => {
      const newSlideId = getCurrentSlideId();
      if (newSlideId && newSlideId !== lastSlideId) {
        lastSlideId = newSlideId;
        debounceSlideChange(300);
      }
    }, 300);

    // 팝업에서 수동 추출 요청
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'GET_SLIDE_INFO') {
        const slideId = getCurrentSlideId();
        const { slideNumber } = getSlidePageInfo(slideId);
        sendResponse({ slideId, slideNumber });
        return false;
      }

      if (message.type === 'EXTRACT_NOW') {
        lastExtractedText = ''; // 캐시 무효화 → 강제 재추출
        lastSentSlideId = null;
        const text = extractSlideText();
        if (text && text.trim().length >= 5) {
          lastExtractedText = text;
          const currentSlideId = getCurrentSlideId() || 'manual';
          const { slideNumber } = getSlidePageInfo(currentSlideId);
          chrome.runtime.sendMessage({
            type: 'SLIDE_TEXT',
            text: text,
            slideId: currentSlideId,
            slideNumber,
            url: window.location.href
          });
          sendResponse({ success: true, textLength: text.length });
        } else {
          sendResponse({ success: false, error: 'NO_TEXT_FOUND' });
        }
      }
    });

    // 초기 자동 추출 없음 — 팝업의 버튼으로만 번역 시작
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSlideWatcher);
  } else {
    initSlideWatcher();
  }
})();
