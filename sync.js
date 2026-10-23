// Vercel 서버리스 함수: 꿈꾸는 라만차랜드 계정 + 기록 동기화
// 저장소: Upstash Redis (Vercel Marketplace에서 연결하면 환경변수가 자동으로 들어옵니다)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (또는 KV_REST_API_URL / KV_REST_API_TOKEN)
const crypto = require('crypto');

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const MAX_DATA = 30000;     // 저장 데이터 최대 크기(문자)
const MAX_TOKENS = 5;       // 동시에 로그인 유지할 기기 수
const MAX_FAILS = 10;       // 10분 안에 이 횟수 이상 틀리면 잠시 차단

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const same = (a, b) => {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const userKey = id => 'lamancha:user:' + sha('id:' + id);   // 아이디 원문 대신 해시로 저장
// 운영자 계정: 아이디는 'admin' 고정, 비밀번호는 Vercel 환경변수 ADMIN_PASSWORD (코드에는 없음). 일반 가입으로는 만들 수 없다.
const ADMIN_ID = 'admin';
const ADMIN_PW = (process.env.ADMIN_PASSWORD || '').trim();
const ID_RE = /^[A-Za-z0-9_가-힣]{3,20}$/;

async function getUser(id) {
  const raw = await redis(['GET', userKey(id)]);
  return raw ? JSON.parse(raw) : null;
}
async function issueToken(user, id) {
  const token = crypto.randomBytes(24).toString('hex');
  user.tokens = [...(user.tokens || []), sha(token)].slice(-MAX_TOKENS);
  await redis(['SET', userKey(id), JSON.stringify(user)]);
  return token;
}
function authed(user, token) {
  return !!user && typeof token === 'string' && (user.tokens || []).some(h => same(h, sha(token)));
}
// 기록 데이터 형태를 느슨하게 검사 (저장 슬롯 + 엔딩 도감만 허용)
function cleanData(d) {
  if (!d || typeof d !== 'object') return null;
  const out = { save: null, progress: null };
  if (d.save && typeof d.save === 'object') out.save = d.save;
  if (d.progress && typeof d.progress === 'object') out.progress = d.progress;
  const s = JSON.stringify(out);
  return s.length <= MAX_DATA ? out : null;
}

// 이 사이트들에서 온 요청만 허용 (GitHub Pages 주소 + 로컬 테스트)
const ALLOW = ['https://dreaming-lamanchaland.github.io'];
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin || '';
  if (ALLOW.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  const fail = (code, error) => res.status(code).json({ error });
  // 점검용: 주소창에서 이 주소를 열면 서버 상태(비밀값은 보여주지 않고 있음/없음만)를 알려 준다
  if (req.method === 'GET') return res.status(200).json({ version: 2, adminPasswordSet: !!ADMIN_PW, adminPasswordLength: ADMIN_PW.length, storageConnected: !!(REDIS_URL && REDIS_TOKEN) });
  if (req.method !== 'POST') return fail(405, '잘못된 요청이에요.');
  if (!REDIS_URL || !REDIS_TOKEN) return fail(500, '서버 저장소가 아직 연결되지 않았어요.');

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = b.action;
    const id = String(b.id || '').trim().toLowerCase();
    if (!ID_RE.test(id)) return fail(400, '아이디는 3~20자의 한글·영문·숫자·_ 만 쓸 수 있어요.');

    if (action === 'register') {
      if (id === ADMIN_ID) return fail(409, '이미 있는 아이디예요.');
      const pw = String(b.password || '');
      if (pw.length < 6 || pw.length > 100) return fail(400, '비밀번호는 6자 이상이어야 해요.');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { salt, hash: hashPw(pw, salt), tokens: [], data: null, created: Date.now() };
      const ok = await redis(['SET', userKey(id), JSON.stringify(user), 'NX']);
      if (ok !== 'OK') return fail(409, '이미 있는 아이디예요.');
      const token = await issueToken(user, id);
      return res.status(200).json({ id, token });
    }

    if (action === 'login') {
      const failKey = 'lamancha:fail:' + sha('id:' + id);
      const fails = Number(await redis(['GET', failKey])) || 0;
      if (fails >= MAX_FAILS) return fail(429, '시도가 너무 많아요. 10분 뒤에 다시 해주세요.');
      const pw = String(b.password || '');
      if (id === ADMIN_ID) {   // 운영자 로그인
        const ok = !!ADMIN_PW && same(sha(pw), sha(ADMIN_PW));
        if (!ok) {
          await redis(['INCR', failKey]); await redis(['EXPIRE', failKey, 600]);
          return fail(401, '아이디 또는 비밀번호가 맞지 않아요.');
        }
        await redis(['DEL', failKey]);
        const adm = (await getUser(id)) || { salt: '', hash: '', tokens: [], data: null, created: Date.now() };
        const token = await issueToken(adm, id);
        return res.status(200).json({ id, token, admin: true });
      }
      const user = await getUser(id);
      if (!user || !same(hashPw(pw, user.salt), user.hash)) {
        await redis(['INCR', failKey]); await redis(['EXPIRE', failKey, 600]);
        return fail(401, '아이디 또는 비밀번호가 맞지 않아요.');
      }
      await redis(['DEL', failKey]);
      const token = await issueToken(user, id);
      return res.status(200).json({ id, token });
    }

    if (action === 'save' || action === 'load') {
      const user = await getUser(id);
      if (!authed(user, b.token)) return fail(401, '로그인이 필요해요. 다시 로그인해 주세요.');
      if (action === 'load') return res.status(200).json({ data: user.data || null, updated: user.updated || null, admin: id === ADMIN_ID });
      const data = cleanData(b.data);
      if (!data) return fail(400, '저장할 수 없는 데이터예요.');
      user.data = data; user.updated = Date.now();
      await redis(['SET', userKey(id), JSON.stringify(user)]);
      return res.status(200).json({ ok: true, updated: user.updated });
    }

    return fail(400, '알 수 없는 요청이에요.');
  } catch (e) {
    return fail(500, '서버 오류가 발생했어요.');
  }
};
