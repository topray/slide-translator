#!/usr/bin/env node
// scripts/watch.js
// 파일 변경 감지 → Extension 자동 리로드 (WebSocket 신호 방식)
//
// 동작 원리:
//   1. 이 스크립트가 WebSocket 서버를 localhost:7788에 엽니다
//   2. Extension의 service worker가 서버에 연결해 대기합니다
//   3. 파일이 바뀌면 서버가 "reload" 신호를 보냅니다
//   4. Service worker가 chrome.runtime.reload()를 호출합니다
//
// 사용법: npm run dev

const chokidar = require('chokidar');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WS_PORT = 7788;

// ─── WebSocket 클라이언트 집합 ───────────────────────────────────────────────

const clients = new Set();

// ─── WebSocket 프레임 인코딩 (텍스트, < 126바이트) ──────────────────────────

function wsSend(socket, text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length >= 126) throw new Error('메시지가 너무 깁니다');
  const frame = Buffer.alloc(buf.length + 2);
  frame[0] = 0x81; // FIN + text opcode
  frame[1] = buf.length; // 마스크 없음 (서버→클라이언트)
  buf.copy(frame, 2);
  socket.write(frame);
}

function broadcast(text) {
  for (const s of clients) {
    try { wsSend(s, text); } catch { clients.delete(s); }
  }
}

// ─── HTTP 서버 (WebSocket upgrade 포함) ─────────────────────────────────────

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('슬라이드 번역기 Dev Server\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  // 이전 연결 정리 (Service Worker 재시작 시 이전 인스턴스 소켓이 남아있을 수 있음)
  for (const old of clients) {
    try { old.destroy(); } catch {}
  }
  clients.clear();

  clients.add(socket);
  console.log(`  🔌 Extension 연결됨`);

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

// ─── 파일 변경 감시 ───────────────────────────────────────────────────────────

let reloadTimer = null;

function scheduleReload(changedFile) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const relPath = path.relative(PROJECT_ROOT, changedFile);
    const ts = new Date().toLocaleTimeString('ko-KR');
    console.log(`\n[${ts}] 📝 ${relPath}`);

    if (clients.size > 0) {
      broadcast('reload');
      console.log(`  🔄 리로드 신호 전송 → ${clients.size}개 연결`);
    } else {
      console.log('  ⚠️  연결된 Extension 없음');
      console.log('  → chrome://extensions 에서 익스텐션을 한 번 새로고침하세요');
    }
  }, 150);
}

// ─── 시작 ─────────────────────────────────────────────────────────────────────

server.listen(WS_PORT, '127.0.0.1', () => {
  console.log('');
  console.log('┌─────────────────────────────────────────┐');
  console.log('│  🎯 슬라이드 번역기 — 개발 모드          │');
  console.log('└─────────────────────────────────────────┘');
  console.log('');
  console.log(`📡 WebSocket 서버: ws://localhost:${WS_PORT}`);
  console.log(`📁 감시 경로: ${PROJECT_ROOT}`);
  console.log('');
  console.log('⏳ Extension 연결 대기 중...');
  console.log('   익스텐션을 처음 활성화하거나 한 번 수동 새로고침하면');
  console.log('   이후부터는 파일 저장 시 자동으로 리로드됩니다.');
  console.log('');
  console.log('👀 파일 감시 중... Ctrl+C로 종료');
  console.log('─────────────────────────────────────────');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 포트 ${WS_PORT} 이미 사용 중입니다.`);
    console.error(`   기존 프로세스 종료: lsof -ti:${WS_PORT} | xargs kill`);
  } else {
    console.error('서버 오류:', err);
  }
  process.exit(1);
});

chokidar
  .watch(PROJECT_ROOT, {
    ignored: [/node_modules/, /\.git/, /scripts\//, /package.*\.json$/, /\.DS_Store/],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 100 },
  })
  .on('change', scheduleReload)
  .on('add', (f) => { if (!f.includes('node_modules')) scheduleReload(f); })
  .on('error', (err) => console.error('감시 오류:', err));
