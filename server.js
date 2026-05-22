require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const XLSX    = require('xlsx');
const { JSDOM } = require('jsdom');
const path    = require('path');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PORT   = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── 유틸 ─────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function requireEnv(name, label) {
    const v = process.env[name];
    if (!v) throw new Error(`${label} 환경변수(${name})가 설정되지 않았습니다.`);
    return v;
}

function getXmlText(doc, tag) {
    return doc.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
}

// ── 주용도 매핑 ───────────────────────────────────────────────────────────────
// 건축물대장 mainPurpsCdNm 원본값 → 확정 7개 옵션

const PURPOSE_RULES = [
    { kw: ['아파트', '연립주택', '다세대주택', '단독주택', '공동주택'], result: '아파트'   },
    { kw: ['오피스텔'],                                                  result: '오피스텔' },
    { kw: ['제1종근린생활', '제2종근린생활', '근린생활',
            '판매시설', '상업시설', '상가', '소매시장', '시장'],          result: '상가'     },
    { kw: ['업무시설', '사무소'],                                         result: '업무시설' },
    { kw: ['공장', '지식산업센터', '아파트형공장', '아파트형 공장'],       result: '공장'     },
    { kw: ['교육연구', '학교', '학원', '도서관',
            '연구소', '연수원', '대학교'],                                 result: '학교'     },
];

function mapPurpose(raw) {
    if (!raw) return '기타';
    const p = raw.trim();
    for (const rule of PURPOSE_RULES) {
        if (rule.kw.some(kw => p.includes(kw))) return rule.result;
    }
    return '기타';
}

// ── API: 도로명주소 (juso.go.kr) ─────────────────────────────────────────────

async function fetchAddressInfo(keyword) {
    const key = requireEnv('JUSO_API_KEY', '도로명주소 API 키');
    const url = `https://www.juso.go.kr/addrlink/addrLinkApi.do`
        + `?confmKey=${encodeURIComponent(key)}`
        + `&currentPage=1&countPerPage=5`
        + `&keyword=${encodeURIComponent(keyword)}`
        + `&resultType=json`;

    const res  = await fetch(url);
    const data = await res.json();

    const common = data.results?.common;
    if (common?.errorCode !== '0') throw new Error(common?.errorMessage || '주소 API 오류');
    const juso = data.results?.juso?.[0];
    if (!juso) throw new Error('검색된 주소가 없습니다.');

    const admCd = juso.admCd || '';
    return {
        sigunguCd: admCd.substring(0, 5),
        bjdongCd:  admCd.substring(5),
        bun:       juso.lnbrMnnm || '',
        ji:        juso.lnbrSlno || '0',
        roadAddr:  juso.roadAddr  || '',
        jibunAddr: juso.jibunAddr || '',
    };
}

// ── API: 건축물대장 ───────────────────────────────────────────────────────────

async function fetchBuildingRegister({ sigunguCd, bjdongCd, bun, ji = '0' }) {
    const key        = requireEnv('BUILDING_API_KEY', '건축물대장 API 키');
    const paddedBun  = String(bun).padStart(4, '0');
    const paddedJi   = String(ji).padStart(4, '0');
    const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo`
        + `?serviceKey=${key}`
        + `&sigunguCd=${encodeURIComponent(sigunguCd)}`
        + `&bjdongCd=${encodeURIComponent(bjdongCd)}`
        + `&bun=${paddedBun}&ji=${paddedJi}`
        + `&numOfRows=100&pageNo=1`;

    const apiRes  = await fetch(url);
    const rawText = await apiRes.text();

    if (!apiRes.ok) throw new Error(`건축물대장 API HTTP ${apiRes.status}`);

    const xmlText = rawText.replace(/^﻿/, '').trimStart();
    if (!xmlText.startsWith('<')) throw new Error('건축물대장 API 응답이 XML이 아닙니다.');

    const dom      = new JSDOM(xmlText, { contentType: 'text/xml' });
    const xmlDoc   = dom.window.document;
    const total    = parseInt(getXmlText(xmlDoc, 'totalCount') || '0', 10);

    if (total === 0) throw new Error('건축물대장 정보 없음');

    const items  = Array.from(xmlDoc.getElementsByTagName('item'));
    let   target = items.find(i => i.getElementsByTagName('mainAtchGbCd')[0]?.textContent === '0');
    if (!target) target = items[0];

    const get = tag => target.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    return {
        bldNm:         get('bldNm'),
        mainPurpsCdNm: get('mainPurpsCdNm'),
        totArea:       get('totArea'),
        platArea:      get('platArea'),
        archArea:      get('archArea'),
        useAprDay:     get('useAprDay'),
    };
}

// ── API: 카카오 주소 검색 ─────────────────────────────────────────────────────

async function fetchKakaoAddress(address) {
    const key = requireEnv('KAKAO_REST_API_KEY', '카카오 REST API 키');
    const url = `https://dapi.kakao.com/v2/local/search/address.json`
        + `?query=${encodeURIComponent(address)}&analyze_type=exact`;

    const res  = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
    if (!res.ok) throw new Error(`카카오 API HTTP ${res.status}`);

    const data = await res.json();
    const doc  = data.documents?.[0];
    if (!doc) return { buildingName: '', standardAddr: '' };

    return {
        buildingName: doc.road_address?.building_name
                   || doc.address?.building_name
                   || '',
        standardAddr: doc.road_address?.address_name
                   || doc.address?.address_name
                   || '',
    };
}

// ── 주소 1건 처리 ─────────────────────────────────────────────────────────────

async function processAddress(rawAddr) {
    const addr = rawAddr.trim();
    if (!addr) return { input: rawAddr, status: 'skip', reason: '빈 주소' };

    try {
        // 1) 카카오 → 표준 도로명주소 + 건물명
        let kakaoName    = '';
        let kakaoAddr    = '';
        try {
            const k    = await fetchKakaoAddress(addr);
            kakaoName  = k.buildingName;
            kakaoAddr  = k.standardAddr;
        } catch { /* 카카오 실패 → 원본 주소로 계속 */ }

        // 2) 도로명주소 API → 행정코드
        const addrInfo = await fetchAddressInfo(kakaoAddr || addr);

        // 3) 건축물대장 → 건물명 + 주용도
        const building = await fetchBuildingRegister(addrInfo);

        // 카카오 건물명이 없으면 건축물대장 bldNm 사용
        const finalKakaoName = kakaoName || building.bldNm || '';

        return {
            input:           addr,
            standardAddr:    addrInfo.roadAddr,
            jibunAddr:       addrInfo.jibunAddr,
            buildingName:    finalKakaoName,
            rawPurpose:      building.mainPurpsCdNm,
            mappedPurpose:   mapPurpose(building.mainPurpsCdNm),
            totArea:         building.totArea,
            useAprDay:       building.useAprDay,
            status:          'ok',
        };
    } catch (err) {
        return { input: addr, status: 'error', reason: err.message };
    }
}

// ── 라우트 ────────────────────────────────────────────────────────────────────

/** GET /health */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        env: {
            juso:     !!process.env.JUSO_API_KEY,
            building: !!process.env.BUILDING_API_KEY,
            kakao:    !!process.env.KAKAO_REST_API_KEY,
        },
        time: new Date().toLocaleString('ko-KR'),
    });
});

/**
 * POST /api/parse-file
 * multipart: file (CSV 또는 xlsx/xls)
 * → 주소 배열 반환
 */
app.post('/api/parse-file', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '파일이 없습니다.' });

        const ext = path.extname(req.file.originalname).toLowerCase();
        let addresses = [];

        if (ext === '.csv') {
            // CSV: UTF-8 또는 EUC-KR 처리
            let text = req.file.buffer.toString('utf8');
            // BOM 제거
            if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

            const lines = text.split(/\r?\n/).filter(l => l.trim());
            // 첫 줄이 헤더인지 판단 (주소처럼 생기지 않으면 헤더로 간주)
            const startIdx = /^\d|^[가-힣]/.test(lines[0]?.split(',')[0]?.trim()) ? 0 : 1;
            addresses = lines.slice(startIdx).map(l => {
                // 쉼표로 구분된 첫 번째 컬럼 (따옴표 제거)
                const col = l.split(',')[0].replace(/^"|"$/g, '').trim();
                return col;
            }).filter(Boolean);

        } else if (['.xlsx', '.xls', '.xlsm'].includes(ext)) {
            const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
            const ws   = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
            // 첫 번째 컬럼을 주소로 사용, 첫 행이 헤더면 제외
            const startIdx = rows.length > 0 && typeof rows[0][0] === 'string'
                && !/^\d|^[가-힣]/.test(rows[0][0]) ? 1 : 0;
            addresses = rows.slice(startIdx).map(r => String(r[0] || '').trim()).filter(Boolean);

        } else {
            return res.status(400).json({ error: 'CSV 또는 Excel 파일만 지원합니다.' });
        }

        res.json({ count: addresses.length, addresses });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/batch-lookup  (SSE 스트리밍)
 * body: { addresses: string[], delayMs?: number }
 */
app.post('/api/batch-lookup', async (req, res) => {
    const { addresses, delayMs = 400 } = req.body;

    if (!Array.isArray(addresses) || addresses.length === 0) {
        return res.status(400).json({ error: '주소 배열이 비어있습니다.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const results = [];

    for (let i = 0; i < addresses.length; i++) {
        send({ type: 'progress', current: i + 1, total: addresses.length, address: addresses[i] });

        const result = await processAddress(addresses[i]);
        results.push(result);

        send({ type: 'record', index: i, result });
        if (i < addresses.length - 1) await sleep(delayMs);
    }

    send({ type: 'complete', results });
    res.end();
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🏢 Building Lookup — http://localhost:${PORT}`);
    console.log(`   JUSO=${!!process.env.JUSO_API_KEY} | BUILDING=${!!process.env.BUILDING_API_KEY} | KAKAO=${!!process.env.KAKAO_REST_API_KEY}\n`);
});
