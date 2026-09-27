require('dotenv').config();
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const PROFILE_URL = process.env.ENTRY_PROFILE_URL;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const AUTHOR_NAME = process.env.AUTHOR_NAME || 'Chime';
const SEEN_FILE = path.join(__dirname, 'seen-projects.json');

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenSet], null, 2), 'utf-8');
}

async function fetchProjectList(browser) {
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  );
  await page.goto(PROFILE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('a[href^="/project/"]', { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  const projects = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href^="/project/"]'));
    const map = new Map();
    let debugPrinted = false;
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/^\/project\/([a-f0-9]{24})/i);
      if (!match) continue;
      const id = match[1];
      if (map.has(id)) continue;
      const img = a.querySelector('img');

      if (!debugPrinted && img) {
        console.log('DEBUG img.outerHTML:', img.outerHTML);
        debugPrinted = true;
      }

      const title = (img && img.getAttribute('alt')) || a.textContent.trim() || '제목 없음';
      let thumbnail = img
        ? img.getAttribute('src') || img.getAttribute('data-src') || ''
        : '';
      if (thumbnail && thumbnail.startsWith('/')) {
        thumbnail = 'https://playentry.org' + thumbnail;
      }
      map.set(id, {
        id,
        title,
        url: `https://playentry.org/project/${id}`,
        thumbnail,
      });
    }
    return Array.from(map.values());
  });

  await page.close();
  return projects;
}

async function notifyDiscord(project) {
  const embed = {
    title: project.title,
    url: project.url,
    color: 0x21c25e,
  };
  if (project.thumbnail) {
    embed.image = { url: project.thumbnail };
  }

  const body = {
    content: `📢 **${AUTHOR_NAME}**님의 새로운 작품이 공개되었습니다!\n${project.url}`,
    embeds: [embed],
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error('디스코드 전송 실패:', res.status, await res.text());
  }
}

async function main() {
  if (!PROFILE_URL || !WEBHOOK_URL) {
    console.error('환경변수 ENTRY_PROFILE_URL, DISCORD_WEBHOOK_URL이 설정되어야 합니다.');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const seen = loadSeen();
  const projects = await fetchProjectList(browser);
  await browser.close();

  if (seen.size === 0) {
    console.log('최초 실행: 현재 작품 목록을 기준선으로 저장합니다 (알림 없음).');
    projects.forEach((p) => seen.add(p.id));
    saveSeen(seen);
    console.log(`${seen.size}개 작품을 기준선으로 저장했습니다.`);
    return;
  }

  const newOnes = projects.filter((p) => !seen.has(p.id));
  if (newOnes.length === 0) {
    console.log('새로운 작품 없음.');
    return;
  }

  for (const project of newOnes.reverse()) {
    console.log('새 작품 발견:', project.title, project.url);
    await notifyDiscord(project);
    seen.add(project.id);
  }
  saveSeen(seen);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
