require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { JSDOM } = require('jsdom');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

// ── 주용도 매핑 (건축물대장 원본값 → 확정 7개 옵션) ─────────────────────────

const PURPOSE_RULES = [
    { keywords: ['아파트', '연립주택', '다세대주택', '단독주택', '공동주택'],   result: '아파트'    },
    { keywords: ['오피스텔'],                                                    result: '오피스텔'  },
    { keywords: ['제1종근린생활', '제2종근린생활', '근린생활', '판매시설',
                 '상업시설', '상가', '소매시장', '시장'],                         result: '상가'      },
    { keywords: ['업무시설', '사무소'],                                           result: '업무시설' },
    { keywords: ['공장', '지식산업센터', '아파트형공장', '아파트형 공장'],        result: '공장'      },
    { keywords: ['교육연구', '학교', '학원', '도서관', '연구소', '연수원',
                 '대학교'],                                                       result: '학교'      },
];

function mapPurpose(raw) {
    if (!raw) return '기타';
    const p = raw.trim();
    for (const rule of PURPOSE_RULES) {
        if (rule.keywords.some(kw => p.includes(kw))) return rule.result;
    }
    return '기타';
}

// ── API 1: 도로명주소 API → sigunguCd, bjdongCd, bun, ji ────────────────────

async function fetchAddressInfo(keyword) {
    const key = requireEnv('JUSO_API_KEY', '도로명주소 API 키');
    const url = `https://www.juso.go.kr/addrlink/addrLinkApi.do?confmKey=${encodeURIComponent(key)}&currentPage=1&countPerPage=5&keyword=${encodeURIComponent(keyword)}&resultType=json`;
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
        roadAddr:  juso.roadAddr,
        jibunAddr: juso.jibunAddr,
    };
}

// ── API 2: 건축물대장 API → 건물명, 주용도 원본값 ───────────────────────────

async function fetchBuildingRegister({ sigunguCd, bjdongCd, bun, ji = '0' }) {
    const key       = requireEnv('BUILDING_API_KEY', '건축물대장 API 키');
    const paddedBun = String(bun).padStart(4, '0');
    const paddedJi  = String(ji).padStart(4, '0');
    const url = `https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo?serviceKey=${key}&sigunguCd=${encodeURIComponent(sigunguCd)}&bjdongCd=${encodeURIComponent(bjdongCd)}&bun=${paddedBun}&ji=${paddedJi}&numOfRows=100&pageNo=1`;

    const apiRes = await fetch(url);
    const rawText = await apiRes.text();

    if (!apiRes.ok) throw new Error(`건축물대장 API HTTP ${apiRes.status}`);

    const xmlText = rawText.replace(/^﻿/, '').trimStart();
    if (!xmlText.startsWith('<')) throw new Error('건축물대장 API 응답이 XML 형식이 아닙니다.');

    const dom    = new JSDOM(xmlText, { contentType: 'text/xml' });
    const xmlDoc = dom.window.document;

    const totalCount = parseInt(getXmlText(xmlDoc, 'totalCount') || '0', 10);
    if (totalCount === 0) throw new Error('해당 지번에 건축물대장 정보가 없습니다.');

    const items  = Array.from(xmlDoc.getElementsByTagName('item'));
    let target   = items.find(item => item.getElementsByTagName('mainAtchGbCd')[0]?.textContent === '0');
    if (!target) target = items[0];

    const getVal = tag => target.getElementsByTagName(tag)[0]?.textContent?.trim() || '';
    return {
        bldNm:          getVal('bldNm'),
        mainPurpsCdNm:  getVal('mainPurpsCdNm'),
        totArea:        getVal('totArea'),
        platArea:       getVal('platArea'),
        archArea:       getVal('archArea'),
        useAprDay:      getVal('useAprDay'),
    };
}

// ── API 3: 카카오 REST API → building_name (건물명(카카오)) ─────────────────

async function fetchKakaoBuildingName(roadAddress) {
    const key = requireEnv('KAKAO_REST_API_KEY', '카카오 REST API 키');
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(roadAddress)}&analyze_type=exact`;
    const res  = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
    if (!res.ok) throw new Error(`카카오 API HTTP ${res.status}`);
    const data = await res.json();
    const doc  = data.documents?.[0];
    if (!doc) return { buildingName: '', standardAddr: roadAddress };
    return {
        buildingName: doc.road_address?.building_name || doc.address?.building_name || '',
        standardAddr: doc.road_address?.address_name  || doc.address?.address_name  || roadAddress,
    };
}

// ── 레코드 1건 처리 ───────────────────────────────────────────────────────────

async function processRecord(record) {
    const addr = (record.address || '').trim();
    if (!addr) return { ...record, status: 'skip', reason: '주소 없음' };

    try {
        // Step 1: 카카오 → building_name + 표준 주소
        let kakaoName  = '';
        let standardAddr = addr;
        try {
            const kakao = await fetchKakaoBuildingName(addr);
            kakaoName   = kakao.buildingName;
            standardAddr = kakao.standardAddr;
        } catch (e) {
            // 카카오 실패 시 원본 주소로 계속
        }

        // Step 2: 도로명주소 API → 지번 코드
        const addrInfo = await fetchAddressInfo(standardAddr || addr);

        // Step 3: 건축물대장 → 건물명, 주용도
        const building = await fetchBuildingRegister(addrInfo);
        const rawPurpose = building.mainPurpsCdNm;
        const mappedPurpose = mapPurpose(rawPurpose);

        // 카카오 building_name 없으면 건축물대장 bldNm 대체
        const finalKakaoName = kakaoName || building.bldNm || '';

        return {
            ...record,
            status:          'ok',
            new_kakaoName:   finalKakaoName,
            new_address:     addrInfo.roadAddr || addr,
            new_rawPurpose:  rawPurpose,
            new_purpose:     mappedPurpose,
            bldInfo:         building,
        };
    } catch (err) {
        return { ...record, status: 'error', reason: err.message };
    }
}

// ── Airtable: 레코드 전체 조회 (페이지네이션) ───────────────────────────────

async function fetchAllAirtableRecords(baseId, tableId, fields) {
    const token  = requireEnv('AIRTABLE_API_KEY', 'Airtable API 키');
    const headers = { Authorization: `Bearer ${token}` };
    const fieldParam = fields.map(f => `fields[]=${encodeURIComponent(f)}`).join('&');

    let records = [];
    let offset  = '';

    do {
        const url = `https://api.airtable.com/v0/${baseId}/${tableId}?${fieldParam}${offset ? `&offset=${offset}` : ''}`;
        const res  = await fetch(url, { headers });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || `Airtable 오류 (HTTP ${res.status})`);
        records = records.concat(data.records || []);
        offset  = data.offset || '';
    } while (offset);

    return records;
}

// ── Airtable: 레코드 일괄 업데이트 (50개씩) ─────────────────────────────────

async function patchAirtableRecords(baseId, tableId, updates) {
    const token  = requireEnv('AIRTABLE_API_KEY', 'Airtable API 키');
    const url    = `https://api.airtable.com/v0/${baseId}/${tableId}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const results = [];

    for (let i = 0; i < updates.length; i += 10) {
        const chunk = updates.slice(i, i + 10);
        const res   = await fetch(url, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ records: chunk }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || `Airtable 업데이트 오류 (HTTP ${res.status})`);
        results.push(...(data.records || []));
        await sleep(250); // rate limit
    }
    return results;
}

// ── 라우트 ────────────────────────────────────────────────────────────────────

/**
 * GET /health
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        env: {
            juso:     !!process.env.JUSO_API_KEY,
            building: !!process.env.BUILDING_API_KEY,
            kakao:    !!process.env.KAKAO_REST_API_KEY,
            airtable: !!process.env.AIRTABLE_API_KEY,
        },
        time: new Date().toLocaleString('ko-KR'),
    });
});

/**
 * POST /api/fetch-records
 * body: { baseId, tableId, fields: { name, address, kakaoName, purpose } }
 */
app.post('/api/fetch-records', async (req, res) => {
    try {
        const { baseId, tableId, fields } = req.body;
        if (!baseId || !tableId || !fields) return res.status(400).json({ error: '필수 파라미터 누락' });

        const fieldNames = Object.values(fields).filter(Boolean);
        const raw = await fetchAllAirtableRecords(baseId, tableId, fieldNames);

        const records = raw.map(r => ({
            id:         r.id,
            name:       r.fields[fields.name]       || '',
            address:    r.fields[fields.address]    || '',
            kakaoName:  r.fields[fields.kakaoName]  || '',
            purpose:    Array.isArray(r.fields[fields.purpose])
                            ? r.fields[fields.purpose].map(o => o.name || o).join(', ')
                            : (r.fields[fields.purpose] || ''),
        }));

        res.json({ count: records.length, records });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/batch-lookup  (SSE 스트리밍)
 * body: { records: [{id, name, address, kakaoName, purpose}] }
 * 진행 상황을 text/event-stream으로 반환
 */
app.post('/api/batch-lookup', async (req, res) => {
    const { records, delayMs = 400 } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: '레코드 배열이 비어있습니다.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const results = [];

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        send({ type: 'progress', current: i + 1, total: records.length, name: record.name || record.address });

        const result = await processRecord(record);
        results.push(result);

        send({ type: 'record', index: i, result });
        await sleep(delayMs);
    }

    send({ type: 'complete', total: records.length, results });
    res.end();
});

/**
 * POST /api/apply-updates
 * body: { baseId, tableId, fields, approved: [{id, new_kakaoName, new_address, new_purpose}] }
 */
app.post('/api/apply-updates', async (req, res) => {
    try {
        const { baseId, tableId, fields, approved } = req.body;
        if (!baseId || !tableId || !fields || !Array.isArray(approved) || approved.length === 0) {
            return res.status(400).json({ error: '필수 파라미터 누락' });
        }

        const updates = approved.map(item => {
            const f = {};
            if (fields.kakaoName && item.new_kakaoName !== undefined) {
                f[fields.kakaoName] = item.new_kakaoName;
            }
            if (fields.address && item.new_address) {
                f[fields.address] = item.new_address;
            }
            if (fields.purpose && item.new_purpose) {
                // multi-select: array of { name }
                f[fields.purpose] = [{ name: item.new_purpose }];
            }
            return { id: item.id, fields: f };
        });

        const updated = await patchAirtableRecords(baseId, tableId, updates);
        res.json({ success: true, count: updated.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/address-info  (개별 조회 — 테스트용)
 */
app.get('/api/address-info', async (req, res) => {
    try {
        const keyword = String(req.query.keyword || '').trim();
        if (!keyword) return res.status(400).json({ error: '주소 검색어가 필요합니다.' });
        const data = await fetchAddressInfo(keyword);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/building-register  (개별 조회 — 테스트용)
 */
app.get('/api/building-register', async (req, res) => {
    try {
        const { sigunguCd, bjdongCd, bun, ji } = req.query;
        if (!sigunguCd || !bjdongCd || !bun) return res.status(400).json({ error: '파라미터 부족' });
        const data = await fetchBuildingRegister({ sigunguCd, bjdongCd, bun, ji });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── 서버 시작 ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🏢 Building Lookup Service`);
    console.log(`   → http://localhost:${PORT}`);
    console.log(`   ENV: JUSO=${!!process.env.JUSO_API_KEY} | BUILDING=${!!process.env.BUILDING_API_KEY} | KAKAO=${!!process.env.KAKAO_REST_API_KEY} | AIRTABLE=${!!process.env.AIRTABLE_API_KEY}\n`);
});
