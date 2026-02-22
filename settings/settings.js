// settings/settings.js

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
});

// ─── Load Settings ────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    'claudeApiKey',
    'selectedModel'
  ]);

  // API key: show masked version if exists
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (stored.claudeApiKey) {
    apiKeyInput.value = stored.claudeApiKey;
  }

  // Model selection (default: sonnet)
  const modelSelect = document.getElementById('modelSelect');
  if (stored.selectedModel) {
    modelSelect.value = stored.selectedModel;
  }
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

function setupEventListeners() {
  // Toggle API key visibility
  document.getElementById('toggleVisibility')?.addEventListener('click', () => {
    const input = document.getElementById('apiKeyInput');
    const btn = document.getElementById('toggleVisibility');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🙈';
    } else {
      input.type = 'password';
      btn.textContent = '👁';
    }
  });

  // Test API connection (via service worker to avoid CORS)
  document.getElementById('testApiKey')?.addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    if (!apiKey) {
      showApiKeyStatus('error', 'API 키를 입력해주세요.');
      return;
    }

    showApiKeyStatus('loading', '연결 테스트 중...');
    document.getElementById('testApiKey').disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'TEST_API_KEY',
        apiKey
      });

      if (result.success) {
        showApiKeyStatus('success', '✓ 연결 성공! API 키가 유효합니다.');
      } else if (result.code === 'INVALID_API_KEY') {
        showApiKeyStatus('error', '✗ API 키가 올바르지 않습니다.');
      } else if (result.code === 'RATE_LIMIT') {
        showApiKeyStatus('success', '✓ API 키는 유효합니다 (요청 한도 초과 상태).');
      } else {
        showApiKeyStatus('error', `✗ 오류 발생: ${result.code}`);
      }
    } catch (e) {
      showApiKeyStatus('error', `✗ 오류: ${e.message}`);
    } finally {
      document.getElementById('testApiKey').disabled = false;
    }
  });

  // Save API key
  document.getElementById('saveApiKey')?.addEventListener('click', async () => {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    if (!apiKey) {
      showApiKeyStatus('error', 'API 키를 입력해주세요.');
      return;
    }
    await chrome.storage.local.set({ claudeApiKey: apiKey });
    showApiKeyStatus('success', '✓ API 키가 저장되었습니다.');
    showToast('API 키 저장 완료!');
  });

  // Save translation settings
  document.getElementById('saveSettings')?.addEventListener('click', async () => {
    const selectedModel = document.getElementById('modelSelect').value;

    await chrome.storage.local.set({ selectedModel });
    showToast('설정이 저장되었습니다!');
  });

  // Clear translation cache
  document.getElementById('clearCache')?.addEventListener('click', async () => {
    if (!confirm('번역 캐시를 초기화하시겠습니까?\n이후 슬라이드는 다시 API를 호출합니다.')) return;

    await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    await chrome.storage.local.remove(['lastResult']);
    showToast('번역 캐시가 초기화되었습니다.');
  });

  // Clear all data
  document.getElementById('clearAll')?.addEventListener('click', async () => {
    if (!confirm('모든 설정과 데이터를 삭제하시겠습니까?\nAPI 키를 포함한 모든 정보가 삭제됩니다.')) return;

    await chrome.storage.local.clear();
    await loadSettings(); // Reset UI
    document.getElementById('apiKeyInput').value = '';
    showApiKeyStatus('success', '모든 데이터가 삭제되었습니다.');
    showToast('모든 데이터가 삭제되었습니다.');
  });
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showApiKeyStatus(type, message) {
  const el = document.getElementById('apiKeyStatus');
  el.className = `status-message status-${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');

  // Force reflow to restart animation
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2500);
}
