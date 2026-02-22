// scripts/build.js
// 배포용 zip 파일 생성 스크립트
// 사용법: node scripts/build.js

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ZIP_NAME = 'slide-translator.zip';
const ZIP_PATH = path.join(DIST_DIR, ZIP_NAME);

// 배포에 포함할 파일/폴더
const INCLUDE = [
  'manifest.json',
  'background',
  'content',
  'popup',
  'settings',
  'utils',
  'icons',
];

// dist 폴더 초기화
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 포함 항목들을 dist/src 임시 폴더에 복사
const SRC_COPY = path.join(DIST_DIR, '_src');
fs.mkdirSync(SRC_COPY);

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  const dest = path.join(SRC_COPY, item);
  if (!fs.existsSync(src)) {
    console.warn(`⚠️  포함 항목 없음 (건너뜀): ${item}`);
    continue;
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`✅ 복사: ${item}`);
}

// 개발 전용 코드 제거 (__DEV_START__ ~ __DEV_END__ 블록 삭제)
function stripDevCode(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stripDevCode(fullPath);
    } else if (entry.name.endsWith('.js')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const stripped = content.replace(
        /\/\/ __DEV_START__[\s\S]*?\/\/ __DEV_END__\n?/g,
        ''
      );
      if (stripped !== content) {
        fs.writeFileSync(fullPath, stripped, 'utf-8');
        console.log(`🧹 개발 코드 제거: ${path.relative(DIST_DIR, fullPath)}`);
      }
    }
  }
}

stripDevCode(SRC_COPY);

// zip 생성 (macOS/Linux: zip 명령어 사용)
try {
  execSync(`cd "${SRC_COPY}" && zip -r "${ZIP_PATH}" .`, { stdio: 'pipe' });
  console.log(`\n📦 빌드 완료: dist/${ZIP_NAME}`);

  // 파일 크기 출력
  const stat = fs.statSync(ZIP_PATH);
  const kb = (stat.size / 1024).toFixed(1);
  console.log(`   크기: ${kb} KB`);
} catch (e) {
  console.error('❌ zip 생성 실패:', e.message);
  process.exit(1);
} finally {
  // 임시 복사 폴더 삭제
  fs.rmSync(SRC_COPY, { recursive: true });
}

console.log('\n배포 절차:');
console.log('  1. chrome://extensions → 개발자 모드 ON');
console.log('  2. "압축 해제된 확장 프로그램 로드" → dist/_src 대신 zip 풀어서 테스트');
console.log('  3. https://chrome.google.com/webstore/devconsole 에서 zip 업로드');
