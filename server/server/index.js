require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// [추가] MySQL 연결 풀 생성
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'facegpt',
  waitForConnections: true,
  connectionLimit: 10,
});




// [추가] http, ws
const http = require('http');
const { WebSocketServer } = require('ws');


const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// ----------------------------------------------------
// 0) rules 로드
// ----------------------------------------------------
const RULES_PATH = path.join(__dirname, 'rules', 'emotion-strategy.json');
const RULES = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));

// --- 간단 로그 유틸 (ndjson 한 줄씩) ----------------------------------------
const LOG_PATH = path.join(__dirname, 'logs', 'calibration.ndjson');
function appendLog(obj){
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(obj) + '\n', 'utf8');
  } catch (e) {
    console.warn('log fail', e.message);
  }
}

// --- (옵션) 온도 캘리브레이션 설정 로드 ------------------------------------
const CALIB_PATH = path.join(__dirname, 'calibration-temp.json');
let CALIB = null;
try { CALIB = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf-8')); }
catch { CALIB = null; }

// [NEW] 캘리브 파일 핫리로드(있을 때만 watch)
try {
  if (fs.existsSync(CALIB_PATH)) {
    fs.watch(CALIB_PATH, { persistent: false }, () => {
      try {
        CALIB = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf-8'));
        console.log('[CALIB] reloaded');
      } catch (e) {
        console.warn('[CALIB] reload failed:', e.message);
      }
    });
  }
} catch (e) {
  console.warn('[CALIB] watch not set:', e.message);
}

// 유틸: logit + softmax
function _logit(p){ const e=1e-6; p=Math.min(Math.max(p,e),1-e); return Math.log(p/(1-p)); }
function _softmax(obj){
  const exps = Object.fromEntries(Object.entries(obj).map(([k,v])=>[k, Math.exp(v)]));
  const Z = Object.values(exps).reduce((a,b)=>a+b,0) || 1;
  return Object.fromEntries(Object.entries(exps).map(([k,v])=>[k, v/Z]));
}

// 온도 스케일링 (감정·집단별)
function applyTemperatureScaling(dist, { trait=null, gender=null }, TAU){
  if (!dist || !TAU) return dist;
  const key = `${trait||'none'}:${gender||'none'}`;
  // [SAFE] 키가 없으면 default 사용
  const tau = TAU[key] || TAU['default'];
  if (!tau) return dist;
  const scaled = {};
  for (const [emo, p] of Object.entries(dist)) {
    const t = Number(tau[emo] || 1.0);
    scaled[emo] = _logit(p) / t;           // 로짓을 τ로 나눔
  }
  return _softmax(scaled);                  // 소프트맥스로 재정규화
}



const EMOTION_ALIAS = {
  fearful: 'fearful',
  fear: 'fearful',
  angry: 'angry',
  disgusted: 'disgusted',
  happy: 'happy',
  sad: 'sad',
  surprised: 'surprised',
  neutral: 'neutral',
};

const EMOTIONS = ["neutral","happy","sad","angry","fearful","disgusted","surprised"];
function normalizeDist(raw) {
  if (!raw) return null;
  const dist = {}; let sum = 0;
  EMOTIONS.forEach(e => { const v = Number(raw?.[e] ?? 0); dist[e] = isNaN(v) ? 0 : v; sum += dist[e]; });
  if (sum > 0) {
    EMOTIONS.forEach(e => (dist[e] = dist[e] / sum));
    return dist;
  }
  // [NEW] 합계가 0이면 균등분포로 폴백
  const uni = 1 / EMOTIONS.length;
  EMOTIONS.forEach(e => (dist[e] = uni));
  return dist;
}
// ⓪ 동적 α 계산 (0.3~0.8에 클램프). quality는 0~1 가정.
function computeAlpha(quality){
  const q = (typeof quality === 'number' && isFinite(quality)) ? quality : 0.5;
  const a = Math.max(0.3, Math.min(0.8, q));
  return a;
}
// (CHG) 50:50 → 동적 α 융합 지원
function fuseEmotion(faceDist, userEmotion, alpha=null) {
  const hasFace = !!faceDist; 
  const hasUser = !!userEmotion;
  if (!hasFace && !hasUser) return null;

  // 가중치 결정
  let wFace, wUser;
  if (alpha != null && hasFace && hasUser){
    wFace = alpha; 
    wUser = 1 - alpha;
  } else {
    wFace = hasFace ? 0.5 : 0;
    wUser = hasUser ? 0.5 : 0;
  }
  const wSum = (wFace + wUser) || 1;

  const fused = {}; 
  let sum = 0;
  EMOTIONS.forEach(e => {
    const fd = hasFace ? (faceDist[e] || 0) : 0;
    const ud = hasUser ? ((userEmotion === e) ? 1 : 0) : 0;
    const s = (fd * wFace + ud * wUser) / wSum;
    fused[e] = s; sum += s;
  });
  if (sum > 0) EMOTIONS.forEach(e => (fused[e] = fused[e] / sum));
  return fused;
}
function argmaxLabel(dist) {
  if (!dist) return 'neutral';
  return Object.entries(dist).sort((a,b)=>b[1]-a[1])[0][0];
}

// --- 성향/성별 민감도 보정기 ----------------------------------------------
// 논문 요지: 낮게 인식되던 감정(외향: sad/angry, 내향: happy/surprised)의 민감도를 올려 정확도 개선.
// face-api.js는 내부 파라미터 접근 불가 → 출력 확률을 “애매한 구간(0.10~0.60)”에서만 소폭 증폭.
function applyTraitGenderSensitivity(dist, { trait=null, gender=null } = {}) {
  if (!dist) return dist;
  const out = { ...dist };

  // [CHG] 파일 기반 곱셈 가중을 우선 사용, 없으면 안전한 기본값 사용
  const traitFromFile  = CALIB?.bias_mult?.trait?.[trait]   || null;
  const genderFromFile = CALIB?.bias_mult?.gender?.[gender] || null;

  // 기본 하드코어 값(파일 없을 때만 사용, 너무 크지 않게)
  const defaultTrait =
    trait === 'introvert' ? { happy: 0.95, surprised: 0.95, sad: 1.10, angry: 1.10 } :
    trait === 'extrovert' ? { happy: 1.10, surprised: 1.10, sad: 0.95, angry: 0.95 } :
    {};
  const defaultGender = {}; // 성별은 기본값 1.0 유지(파일로만 조정)

  const traitBoost  = traitFromFile  || defaultTrait;
  const genderBoost = genderFromFile || defaultGender;

  // 3) 애매한 확률대에서만 증폭 (과보정 방지)
  const LOWER = 0.10, UPPER = 0.60;
  const mult = { neutral:1, happy:1, sad:1, angry:1, fearful:1, disgusted:1, surprised:1,
                 ...traitBoost, ...genderBoost };
  Object.entries(out).forEach(([emo, p]) => {
    const m = mult[emo] ?? 1;
    if (m !== 1 && p >= LOWER && p <= UPPER) out[emo] = p * m;
  });

  // 4) 재정규화
  let s = 0; Object.values(out).forEach(v => s += v);
  if (s > 0) Object.keys(out).forEach(k => out[k] = out[k] / s);

  return out;
}


// ----------------------------------------------------
// 1) Spotify Access Token
// ----------------------------------------------------
let spotifyToken = null;
let spotifyTokenExpireAt = 0;

function safeParseReasons(raw, expectedLen) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (parsed.length > expectedLen) return parsed.slice(0, expectedLen);
      if (parsed.length < expectedLen)
        return [...parsed, ...Array(expectedLen - parsed.length).fill('')];
      return parsed;
    }
  } catch (_) {}

  let content = raw.replace(/```[\s\S]*?```/g, '').trim();
  const arrMatch = content.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) {
        if (parsed.length > expectedLen) return parsed.slice(0, expectedLen);
        if (parsed.length < expectedLen)
          return [...parsed, ...Array(expectedLen - parsed.length).fill('')];
        return parsed;
      }
    } catch (_) {}
  }

  const splitted = content
    .split(/\n+/)
    .map(l => l.replace(/^\s*[-*\d.]+\s*/, '').trim())
    .filter(Boolean);

  let finalArr = splitted;
  if (finalArr.length > expectedLen) finalArr = finalArr.slice(0, expectedLen);
  if (finalArr.length < expectedLen)
    finalArr = [...finalArr, ...Array(expectedLen - finalArr.length).fill('')];

  return finalArr;
}

async function getSpotifyAccessToken() {
  const now = Date.now();
  if (spotifyToken && now < spotifyTokenExpireAt) return spotifyToken;

  try {
    const tokenUrl = 'https://accounts.spotify.com/api/token';
    const authHeader = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString('base64');

    const res = await axios.post(
      tokenUrl,
      new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${authHeader}`
        }
      }
    );

    spotifyToken = res.data.access_token;
    spotifyTokenExpireAt = now + (res.data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch (e) {
    console.error('[Spotify 토큰 요청 실패]', e.response?.data || e.message);
    throw new Error('Spotify token error');
  }
}

// ----------------------------------------------------
// 2) 개인화 유틸 함수
// ----------------------------------------------------
function computeYearWindow(age) {
  const now = new Date().getFullYear();
  if (!age) return null;
  if (age < 20) return [now - 4, now];
  if (age < 30) return [now - 7, now];
  if (age < 40) return [now - 10, now];
  return [now - 15, now];
}

// 사용자의 10대(13~19세) 때 발매된 곡들의 발매연도 구간
function teenageWindow(age) {
  const now = new Date().getFullYear();
  if (!age || isNaN(age) || age < 13 || age > 100) return null;
  const yAt13 = now - (age - 13);
  const yAt19 = now - (age - 19);
  const start = Math.min(yAt13, yAt19);
  const end   = Math.max(yAt13, yAt19);
  const minYear = 1950;
  return [Math.max(minYear, start), Math.min(now, end)];
}

function buildPersonalizedGenres(rule, gender, age) {
  const base = (rule?.seed_genres || []).slice(0);
  const genderGenres = gender === 'male' ? rule?.male_genres : rule?.female_genres;
  const bias = genderGenres || [];

  let ageBias = [];
  if (age < 20) ageBias = ['k-pop', 'dance', 'teen-pop'];
  else if (age < 30) ageBias = ['pop', 'hip-hop', 'indie'];
  else if (age < 40) ageBias = ['soft-rock', 'ballad', 'indie-rock'];
  else ageBias = ['classic-rock', 'jazz', 'blues'];

  return Array.from(new Set([...base, ...bias, ...ageBias]));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const RECENT = new Set();

// 🎵 추억의 노래 기반 추천
async function getNostalgiaTracks(age, want = 3) {
  const token = await getSpotifyAccessToken();
  const win = teenageWindow(age);
  if (!win) return [];

  const [start, end] = win;
  const url = `https://api.spotify.com/v1/search?q=genre:k-pop year:${start}-${end}&type=track&market=KR&limit=50`;

  try {
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const tracks = (r.data.tracks.items || []).map(t => ({
      title: t.name,
      artist: t.artists.map(a => a.name).join(", "),
      spotifyId: t.id,
      spotifyUrl: t.external_urls?.spotify || "",
      youtubeUrl: "",
    }));

    return shuffle(tracks).slice(0, want);
  } catch (e) {
    console.error("[Nostalgia 추천 실패]", e.response?.data || e.message);
    return [];
  }
}







async function getKoreaTopTracks(want = 3) {
  const token = await getSpotifyAccessToken();
  const url = `https://api.spotify.com/v1/search?q=genre:k-pop&type=track&market=KR&limit=50`;

  try {
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const items = r.data.tracks.items || [];

    // ✅ ISRC 코드가 "KR"로 시작하는 곡만 필터링
    const koreanTracks = items.filter(t => t.external_ids?.isrc?.startsWith('KR'));

    const tracks = koreanTracks.map(t => ({
      title: t.name,
      artist: t.artists.map(a => a.name).join(", "),
      spotifyId: t.id,
      spotifyUrl: t.external_urls?.spotify || "",
      youtubeUrl: "",
    }));

    console.log(`[Korean ISRC 필터 결과] ${tracks.length}개`);
    return shuffle(tracks).slice(0, want);
  } catch (e) {
    console.error("[Korea K-POP 추천 실패]", e.response?.data || e.message);
    return [];
  }
}



// 🎧 [NEW] 오디오 피처 기반 감정 필터링 (face-api.js의 7감정 대응)
async function filterTracksByEmotion(tracks, emotion, type = 'empathy') {
  const token = await getSpotifyAccessToken();
  if (!tracks.length) return tracks;

  const ids = tracks.map(t => t.spotifyId).filter(Boolean).join(',');
  if (!ids) return tracks;

  try {
    const { data } = await axios.get(`https://api.spotify.com/v1/audio-features?ids=${ids}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const feats = data.audio_features || [];

    const filtered = tracks.filter((t, i) => {
      const f = feats[i];
      if (!f) return false;

      switch (emotion) {
        // 😐 중립 (Neutral)
        case 'neutral':
          return type === 'empathy'
            ? f.energy >= 0.4 && f.energy <= 0.6 && f.valence >= 0.4 && f.valence <= 0.6
            : f.valence > 0.7 && f.energy > 0.6;

        // 😊 행복 (Happy)
        case 'happy':
          return type === 'empathy'
            ? f.valence > 0.7 && f.energy > 0.6
            : f.energy < 0.5 && f.valence > 0.5;

        // 😢 슬픔 (Sad)
        case 'sad':
          return type === 'empathy'
            ? f.valence < 0.35 && f.energy < 0.6
            : f.valence > 0.6 && f.energy > 0.5;

        // 😠 분노 (Angry)
        case 'angry':
          return type === 'empathy'
            ? f.energy > 0.7 && f.valence < 0.4
            : f.energy < 0.5 && f.valence > 0.6;

        // 😱 공포 (Fearful)
        case 'fearful':
          return type === 'empathy'
            ? f.acousticness > 0.6 && f.energy < 0.5
            : f.valence > 0.6 && f.danceability > 0.5;

        // 🤢 혐오 (Disgusted)
        case 'disgusted':
          return type === 'empathy'
            ? f.valence < 0.4 && f.energy < 0.6
            : f.valence > 0.7 && f.energy > 0.5;

        // 😲 놀람 (Surprised)
        case 'surprised':
          return type === 'empathy'
            ? f.valence > 0.6 && f.energy > 0.6 && f.danceability > 0.5
            : f.valence > 0.6 && f.energy < 0.5;

        // 기타 (예외 처리)
        default:
          return true;
      }
    });

    // ⚠️ 조건에 맞는 곡이 너무 적으면 원본 유지
    if (filtered.length < 2) return tracks;
    return filtered;
  } catch (err) {
    console.error('[filterTracksByEmotion 실패]', err.response?.data || err.message);
    return tracks;
  }
}





// ----------------------------------------------------
// 4) YouTube 검색
// ----------------------------------------------------
const USE_YOUTUBE = !!process.env.YOUTUBE_API_KEY;
async function getYoutubeLink(query) {
  if (!USE_YOUTUBE) return '';
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(
    query
  )}&type=video&maxResults=1&key=${process.env.YOUTUBE_API_KEY}`;

  try {
    const response = await axios.get(url);
    const videoId = response.data.items[0]?.id?.videoId;
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
  } catch (err) {
    console.error(`[YouTube 검색 실패] ${query}:`, err.response?.data || err.message);
    return '';
  }
}

// ----------------------------------------------------
// 5) GPT 추천 이유
// ----------------------------------------------------
const USE_GPT = !!process.env.OPENAI_API_KEY;

async function makeReasonsWithGPT(emotion, tracks, age, gender) {
  if (!USE_GPT || !tracks.length) return tracks.map((t) => ({ ...t, reason: '' }));

  const expectedLen = tracks.length;

  const prompt = `
당신은 음악 심리 전문가입니다.
아래 조건에 맞춰 각 곡의 추천 이유를 JSON 문자열 배열로만 작성하세요.
코드블록(\`\`\`)이나 설명 문구 없이 순수한 JSON 배열만 출력하세요.
배열 길이는 반드시 ${expectedLen}이며, 각 원소는 문자열이어야 합니다.

작성 규칙:
1. category가 "공감"이면, 사용자의 감정을 인정하고 공감하며 해당 감정을 잘 표현하거나 함께 느낄 수 있는 이유를 3~4문장으로 작성하세요.
2. category가 "해소"이면, 사용자의 감정을 긍정적·편안하게 변화시키거나 해소할 수 있는 이유를 3~4문장으로 작성하세요.
3. 곡 제목과 가수를 그대로 언급하세요.
4. 말투는 부드럽고 따뜻하게 하세요.
5. 공감과 해소 두가지의 카테고리로 추천 이유를 설명할때 직접 곡에 대한 정보를 검색해보고 그 검색한 정보들을 기반으로 왜 이 곡이 공감이 되는지 혹은 해소를 해주는지 타당한 이유로 작성하세요.
6. 각 곡의 음향적 특징(valence, energy, danceability 등)을 감정적으로 해석하여 공감 또는 해소 이유를 설명하세요.

사용자 정보:
- 감정: "${emotion}"
- 연령대: "${age}대"
- 성별: "${gender}"

곡 리스트 (category 포함):
${tracks.map((t, i) => `${i + 1}. [${t.category}] ${t.title} - ${t.artist}`).join('\n')}
`;

  try {
    const gptRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Project': process.env.OPENAI_PROJECT_ID,
        },
      }
    );

    const content = gptRes.data.choices?.[0]?.message?.content?.trim() ?? '[]';
    const reasons = safeParseReasons(content, expectedLen);

    return tracks.map((t, idx) => ({
      ...t,
      reason: reasons[idx] || '',
    }));
  } catch (err) {
    console.error('[GPT 이유 생성 실패]', err.response?.data || err.message);
    return tracks.map((t) => ({ ...t, reason: '' }));
  }
}


// ----------------------------------------------------
// /recommend (공감 2곡 + 해소 1곡, 한국 Top 50 기반)
// ----------------------------------------------------
app.post('/recommend', async (req, res) => {
  const { age, gender, emotion, faceDist, userEmotion, faceEmotion,
          nostalgia = 0, trait = null, quality = null, variant = null } = req.body || {};
  console.log('[추천 요청 바디]', req.body);

  let snap_before = null, snap_v1 = null, snap_v2 = null;
  let normEmotion;

  if (faceDist || userEmotion || faceEmotion) {
    let fdist = faceDist ? normalizeDist(faceDist) : null;
    if (!fdist && (faceEmotion || emotion)) {
      const label = EMOTION_ALIAS[faceEmotion] || EMOTION_ALIAS[emotion] || 'neutral';
      fdist = normalizeDist({ [label]: 1 });
    }
    const userLabel = userEmotion ? (EMOTION_ALIAS[userEmotion] || userEmotion) : null;

    // ⬇️ 동적 α 적용
    const alpha = (fdist && userLabel) ? computeAlpha(quality) : null;

    let fused = fuseEmotion(fdist, userLabel, alpha);
    snap_before = { ...fused, alpha_used: alpha };

    fused = applyTraitGenderSensitivity(fused, { trait, gender });
    snap_v1 = { ...fused };

    if (CALIB) {
      fused = applyTemperatureScaling(fused, { trait, gender }, CALIB);
      snap_v2 = { ...fused };
    }

    normEmotion = argmaxLabel(fused);
  } else {
    normEmotion = EMOTION_ALIAS[emotion] || 'neutral';
  }

  appendLog({
    type: 'rec',
    ts: new Date().toISOString(),
    variant, trait, gender, age: age ?? null,
    userEmotion: userEmotion ?? null,
    faceEmotion: faceEmotion ?? null,
    quality: quality ?? null,
    fused_before: snap_before,
    fused_after_v1: snap_v1,
    fused_after_v2: snap_v2,
    finalEmotion: normEmotion,
    nostalgia: !!nostalgia
  });

  try {
    let empathyTracks, reliefTracks;

    if (nostalgia && age) {
        empathyTracks = await getNostalgiaTracks(age, 10);
        reliefTracks  = await getNostalgiaTracks(age, 10);
    } else {
        empathyTracks = await getKoreaTopTracks(10);
        reliefTracks  = await getKoreaTopTracks(10);
    }

    // 🎯 [NEW] 공감·해소 감정 필터링 추가
    empathyTracks = await filterTracksByEmotion(empathyTracks, normEmotion, 'empathy');
    reliefTracks  = await filterTracksByEmotion(reliefTracks, normEmotion, 'relief');

    // 🎯 [NEW] 각 카테고리별로 원하는 개수만 샘플링
    empathyTracks = shuffle(empathyTracks).slice(0, 2);
    reliefTracks  = shuffle(reliefTracks).slice(0, 1);

    const empathyWithCat = empathyTracks.map(t => ({ ...t, category: '공감' }));
    const reliefWithCat  = reliefTracks.map(t => ({ ...t, category: '해소' }));

    let combined = [...empathyWithCat, ...reliefWithCat];

    // YouTube 링크 추가
    combined = await Promise.all(
      combined.map(async t => ({
        ...t,
        youtubeUrl: await getYoutubeLink(`${t.title} ${t.artist}`),
      }))
    );

    // GPT 이유 생성
    const explained = await makeReasonsWithGPT(normEmotion, combined, age, gender);

    res.json({
      recommendations: explained.map(t => ({
        title: t.title,
        artist: t.artist,
        youtubeUrl: t.youtubeUrl,
        category: t.category || null,
        reason: t.reason || '',
      })),
      emotion: normEmotion,
      strategies: {
        empathy: nostalgia ? "nostalgia" : "k-pop-search",
        relief:  nostalgia ? "nostalgia" : "k-pop-search",
        nostalgia: !!nostalgia
      }
    });
  } catch (e) {
    console.error('[recommend 실패]', e.response?.data || e.message);
    res.status(500).json({ error: 'recommend failed' });
  }
});


// POST /recsets  { age, gender, emotion, items:[{title,artist,spotifyId,youtubeUrl,reasonShort} *3] }
app.post('/recsets', async (req, res) => {
  try {
    const { age=null, gender=null, emotion=null, items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok:false, error:'items(추천 목록)이 필요합니다' });
    }
    const [r] = await pool.execute(
      `INSERT INTO rec_sets (emotion, age, gender, items) VALUES (?,?,?,?)`,
      [emotion || null, age || null, gender || null, JSON.stringify(items)]
    );
    res.json({ ok:true, id: r.insertId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});




// [추가] HTTP 서버 핸들러로 Express 연결
const server = http.createServer(app);

// [추가] WS 서버 생성 (경로: /ws)
const wss = new WebSocketServer({ server, path: '/ws' });

// [추가] 채널 관리 (초기엔 default 하나만)
const channels = new Map(); // key: channel, value: Set<ws>
function getChannel(name = 'default') {
  if (!channels.has(name)) channels.set(name, new Set());
  return channels.get(name);
}

// [추가] 웹소켓 연결 처리
wss.on('connection', (ws) => {
  let joined = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello' && msg.role === 'stream') {
        const ch = msg.channel || 'default';
        getChannel(ch).add(ws);
        joined = ch;
        ws.send(JSON.stringify({ type: 'ack', channel: ch }));
      }
    } catch {}
  });

  ws.on('close', () => {
    if (joined) getChannel(joined).delete(ws);
  });
});



// [추가] 사용자 클라 → 스트리밍 클라 브로드캐스트
app.post('/push', async (req, res) => {
  try {
    const {
      channel = 'default',
      song,
      message = '',
      recSetId = null,     // 추천세트 ID
      selectedIdx = null   // 0,1,2 중 전송한 곡 인덱스
    } = req.body || {};

    if (!song || !song.title || !song.artist) {
      return res.status(400).json({ ok: false, error: 'song(title,artist) required' });
    }

    // 클라이언트 정보(선택) — 로깅용
    const clientIp =
      (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) ||
      req.socket.remoteAddress ||
      '';
    const userAgent = req.headers['user-agent'] || '';

    // DB 저장 (push_logs에 rec_set_id, selected_idx 컬럼 있어야 함)
    const [r] = await pool.execute(
      `INSERT INTO push_logs
        (channel, title, artist, youtube_url, spotify_id, message,
         client_ip, user_agent, rec_set_id, selected_idx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        channel,
        song.title,
        song.artist,
        song.youtubeUrl || null,
        song.spotifyId || null,
        message || null,
        clientIp,
        userAgent,
        recSetId,
        selectedIdx
      ]
    );
    const insertedId = r.insertId;

    // 스트리밍 클라로 브로드캐스트 (logId 포함)
    const payload = JSON.stringify({ type: 'play', song, message, logId: insertedId });
    const set = getChannel(channel); // 네 코드의 헬퍼 함수 이름(getChannel) 그대로 사용
    set.forEach((ws) => {
      if (ws.readyState === 1) ws.send(payload);
    });

    return res.json({ ok: true, delivered: set.size, id: insertedId });
  } catch (e) {
    console.error('[push error]', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});


// GET /history/recsets?page=1&pageSize=20
app.get('/history/recsets', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10), 1), 50);
    const offset = (page - 1) * pageSize;

    const [[{cnt}]] = await pool.query(`SELECT COUNT(*) AS cnt FROM rec_sets`);
    const [rows] = await pool.query(
      `SELECT rs.id, rs.emotion, rs.age, rs.gender, rs.items,
              rs.created_at AS createdAt,
              pl.id AS pushId, pl.message, pl.selected_idx AS selectedIdx, pl.created_at AS pushedAt
       FROM rec_sets rs
       LEFT JOIN push_logs pl ON pl.rec_set_id = rs.id
       ORDER BY rs.id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    // rows → 응답 데이터로 정규화
const normalized = rows.map(r => {
  let itemsArr = [];
  try {
    const raw = r.items;
    if (raw == null) {
      itemsArr = [];
    } else if (typeof raw === 'string') {
      // JSON 문자열인 경우
      itemsArr = JSON.parse(raw);
    } else if (Buffer.isBuffer(raw)) {
      // Buffer로 오는 경우
      itemsArr = JSON.parse(raw.toString('utf8'));
    } else if (Array.isArray(raw)) {
      // 이미 배열
      itemsArr = raw;
    } else if (typeof raw === 'object') {
      // 이미 파싱된 객체(배열)
      itemsArr = raw;
    } else {
      itemsArr = [];
    }
  } catch (e) {
    console.error('[history/recsets] items parse fail: id=', r.id, e);
    itemsArr = [];
  }

  return {
    id: r.id,
    emotion: r.emotion,
    age: r.age,
    gender: r.gender,
    items: itemsArr,
    createdAt: r.createdAt,
    push: r.pushId
      ? { id: r.pushId, message: r.message, selectedIdx: r.selectedIdx, pushedAt: r.pushedAt }
      : null
  };
});

res.json({ ok: true, page, pageSize, total: cnt, items: normalized });

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'server error' });
  }
});


app.get('/health', (_, res) => res.json({ ok: true }));

// 스트리밍 클라이언트 정적 제공
app.use('/stream', express.static(path.join(__dirname, 'streaming-client')));

server.listen(PORT, () => {
  console.log(`HTTP+WS on http://localhost:${PORT}`);
});
