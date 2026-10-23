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
const RESET_PW = 'lamancha1';   // 운영자가 재설정해 줄 때 쓰는 임시 비밀번호 (받은 유저가 로그인 후 바로 바꾸도록 안내)
// 사용할 수 없는 아이디 단어 (가입할 때만 검사). 새 단어는 여기에 추가하면 됩니다. 너무 짧은 단어는 정상 단어가 걸릴 수 있어 넣지 않았어요.
const BLOCKED = [
  '시발','씨발','씨팔','시팔','씨빨','병신','븅신','지랄','좆','존나','개새끼','개세끼','썅','쌍년','쌍놈','느금','니미','애미','엠창','씹새','씹년','씹창','씹덕','창녀','미친년','미친놈','섹스','야동','강간','한남충','김치녀','된장녀','맘충','급식충',
  'fuck','shit','bitch','cunt','asshole','nigger','nigga','faggot','whore','slut','porn','dildo','pussy',
  'admin','운영자','관리자',
];
const normForms = id => {   // _ 와 숫자로 돌려 쓴 표기도 잡는다
  const a = id.replace(/_/g, '');
  const b = a.replace(/[0-9]/g, '');
  const leet = a.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/\$/g, 's');
  return [a, b, leet];
};
const isBlockedId = id => normForms(id).some(f => BLOCKED.some(w => f.includes(w)));
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
      if (isBlockedId(id)) return fail(400, '사용할 수 없는 아이디예요. 다른 아이디를 써 주세요.');
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

    // 운영자: 아이디를 입력하면 그 계정의 비밀번호를 임시 비밀번호로 되돌리고, 로그인된 기기를 모두 로그아웃시킨다
    if (action === 'adminReset') {
      const adm = await getUser(id);
      if (id !== ADMIN_ID || !authed(adm, b.token)) return fail(403, '운영자만 쓸 수 있어요.');
      const target = String(b.target || '').trim().toLowerCase();
      if (!ID_RE.test(target) || target === ADMIN_ID) return fail(400, '올바른 아이디가 아니에요.');
      const user = await getUser(target);
      if (!user) return fail(404, '그런 아이디는 없어요.');
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = hashPw(RESET_PW, user.salt);
      user.tokens = [];
      await redis(['SET', userKey(target), JSON.stringify(user)]);
      await redis(['DEL', 'lamancha:fail:' + sha('id:' + target)]);
      return res.status(200).json({ ok: true, target });
    }

    // 운영자: 아이디를 입력하면 그 계정을 지운다 (욕설 아이디 정리용)
    if (action === 'adminDelete') {
      const adm = await getUser(id);
      if (id !== ADMIN_ID || !authed(adm, b.token)) return fail(403, '운영자만 쓸 수 있어요.');
      const target = String(b.target || '').trim().toLowerCase();
      if (!ID_RE.test(target) || target === ADMIN_ID) return fail(400, '올바른 아이디가 아니에요.');
      if (!(await getUser(target))) return fail(404, '그런 아이디는 없어요.');
      await redis(['DEL', userKey(target)]);
      await redis(['DEL', 'lamancha:fail:' + sha('id:' + target)]);
      return res.status(200).json({ ok: true, target });
    }

    // 유저: 로그인한 상태에서 자기 비밀번호 바꾸기 (현재 비밀번호 확인 필요, 다른 기기는 로그아웃)
    if (action === 'changePw') {
      if (id === ADMIN_ID) return fail(400, '운영자 비밀번호는 서버 설정에서 바꿔요.');
      const user = await getUser(id);
      if (!authed(user, b.token)) return fail(401, '로그인이 필요해요. 다시 로그인해 주세요.');
      const oldPw = String(b.password || ''), newPw = String(b.newPassword || '');
      if (!same(hashPw(oldPw, user.salt), user.hash)) return fail(401, '현재 비밀번호가 맞지 않아요.');
      if (newPw.length < 6 || newPw.length > 100) return fail(400, '새 비밀번호는 6자 이상이어야 해요.');
      const keep = sha(b.token);
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = hashPw(newPw, user.salt);
      user.tokens = (user.tokens || []).filter(h => h === keep);
      await redis(['SET', userKey(id), JSON.stringify(user)]);
      return res.status(200).json({ ok: true });
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
