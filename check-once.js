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
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/^\/project\/([a-f0-9]{24})/i);
      if (!match) continue;
      const id = match[1];
      if (map.has(id)) continue;
      map.set(id, { id, url: `https://playentry.org/project/${id}` });
    }
    return Array.from(map.values());
  });

  await page.close();
  return projects;
}

// 작품 상세 페이지에서 제목(og:title)과 대표 이미지(og:image)를 가져오는 함수
async function fetchProjectDetails(browser, projectUrl) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    );
    await page.goto(projectUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));

    const details = await page.evaluate(() => {
      const getMeta = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.getAttribute('content') : '';
      };

      let title =
        getMeta('meta[property="og:title"]') ||
        getMeta('meta[name="twitter:title"]') ||
        (document.querySelector('h1') && document.querySelector('h1').textContent.trim()) ||
        document.title ||
        '';

      let thumbnail =
        getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]') || '';

      return { title, thumbnail };
    });

    if (details.thumbnail && details.thumbnail.startsWith('/')) {
      details.thumbnail = 'https://playentry.org' + details.thumbnail;
    }

    // 제목 끝에 붙는 "| 엔트리" 같은 사이트명 제거
    details.title = details.title.replace(/\s*[|\-–]\s*엔트리.*$/i, '').trim();
    if (!details.title) details.title = '제목 없음';

    return details;
  } catch (err) {
    console.error('상세정보 가져오기 실패:', err.message);
    return { title: '제목 없음', thumbnail: '' };
  } finally {
    await page.close();
  }
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
    content: `📢 **${AUTHOR_NAME}**의 새로운 이야기가 공개되었네~ 이번엔 어떤 운명이 펼쳐질까? ⏳\n${project.url}`,
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

  if (seen.size === 0) {
    console.log('최초 실행: 현재 작품 목록을 기준선으로 저장합니다 (알림 없음).');
    projects.forEach((p) => seen.add(p.id));
    saveSeen(seen);
    console.log(`${seen.size}개 작품을 기준선으로 저장했습니다.`);
    await browser.close();
    return;
  }

  const newOnes = projects.filter((p) => !seen.has(p.id));
  if (newOnes.length === 0) {
    console.log('새로운 작품 없음.');
    await browser.close();
    return;
  }

  for (const project of newOnes.reverse()) {
    const details = await fetchProjectDetails(browser, project.url);
    project.title = details.title;
    project.thumbnail = details.thumbnail;
    console.log('새 작품 발견:', project.title, project.url);
    console.log('가져온 썸네일:', project.thumbnail || '(없음)');
    await notifyDiscord(project);
    seen.add(project.id);
  }
  saveSeen(seen);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
