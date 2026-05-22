// ── 상태 ──────────────────────────────────────────────────────────────────────
const state = {
    addresses:    [],   // 처리할 주소 목록
    results:      [],   // 조회 결과
    activeTab:    'paste',
    fileAddresses: [],  // 파일에서 파싱된 주소
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function show(id)  { $(id).classList.remove('hidden'); }
function hide(id)  { $(id).classList.add('hidden'); }
function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimer;
function showToast(msg, type = 'info', ms = 3000) {
    const el   = $('toast');
    el.textContent = msg;
    el.className   = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ── 서버 헬스 체크 ────────────────────────────────────────────────────────────

async function checkHealth() {
    const badge = $('health-badge');
    try {
        const res  = await fetch('/health');
        const data = await res.json();
        const { juso, building, kakao } = data.env;
        if (juso && building && kakao) {
            badge.className   = 'health-badge health-ok';
            badge.textContent = '✅ 서버 정상';
        } else {
            const missing = [!juso && 'JUSO', !building && 'BUILDING', !kakao && 'KAKAO']
                .filter(Boolean).join(', ');
            badge.className   = 'health-badge health-warn';
            badge.textContent = `⚠️ 미설정: ${missing}`;
        }
    } catch {
        badge.className   = 'health-badge health-err';
        badge.textContent = '❌ 서버 연결 실패';
    }
}

// ── 탭 전환 ───────────────────────────────────────────────────────────────────

$$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        $$('.tab').forEach(b => b.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.add('hidden'));
        btn.classList.add('active');
        state.activeTab = btn.dataset.tab;
        $(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
});

// ── 텍스트 붙여넣기 ───────────────────────────────────────────────────────────

$('input-textarea').addEventListener('input', e => {
    const lines = parseLines(e.target.value);
    $('paste-count').textContent = `${lines.length}개`;
});

$('btn-clear-paste').addEventListener('click', () => {
    $('input-textarea').value = '';
    $('paste-count').textContent = '0개';
});

function parseLines(text) {
    return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// ── 파일 업로드 ───────────────────────────────────────────────────────────────

const dropZone = $('file-drop-zone');
const fileInput = $('file-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
    if (e.target.files[0]) handleFileUpload(e.target.files[0]);
});

async function handleFileUpload(file) {
    const status = $('file-status');
    status.textContent = `⏳ "${file.name}" 파싱 중…`;
    status.className   = 'file-status ok';
    show('file-status');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res  = await fetch('/api/parse-file', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        state.fileAddresses = data.addresses;
        status.textContent  = `✅ "${file.name}" — ${data.count}개 주소 인식됨`;
        status.className    = 'file-status ok';
    } catch (err) {
        status.textContent = `❌ 파싱 오류: ${err.message}`;
        status.className   = 'file-status err';
        state.fileAddresses = [];
    }
}

// ── 조회 시작 ─────────────────────────────────────────────────────────────────

$('btn-run').addEventListener('click', async () => {
    // 주소 수집
    let addresses = [];
    if (state.activeTab === 'paste') {
        addresses = parseLines($('input-textarea').value);
    } else {
        addresses = state.fileAddresses;
    }

    if (addresses.length === 0) {
        showToast('주소를 입력하거나 파일을 업로드해주세요.', 'error'); return;
    }

    state.addresses = addresses;
    state.results   = [];

    // UI 전환
    $('btn-run').disabled = true;
    show('section-progress');
    hide('section-result');
    $('progress-log').innerHTML = '';
    $('progress-bar').style.width = '0%';
    $('progress-text').textContent = `0 / ${addresses.length}`;

    const delayMs = parseInt($('cfg-delay').value);

    try {
        const response = await fetch('/api/batch-lookup', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ addresses, delayMs }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error);
        }

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let   buf     = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) onStreamEvent(JSON.parse(line.slice(6)));
            }
        }
    } catch (err) {
        showToast(`오류: ${err.message}`, 'error', 6000);
    } finally {
        $('btn-run').disabled = false;
    }
});

function onStreamEvent(obj) {
    if (obj.type === 'progress') {
        const pct = Math.round((obj.current / obj.total) * 100);
        $('progress-bar').style.width  = pct + '%';
        $('progress-text').textContent = `${obj.current} / ${obj.total}`;

        const log = $('progress-log');
        const div = document.createElement('div');
        div.className   = 'log-info';
        div.textContent = `[${obj.current}/${obj.total}] ${obj.address}`;
        log.appendChild(div);
        log.scrollTop = log.scrollHeight;
    }

    if (obj.type === 'record') {
        state.results.push(obj.result);
        // 로그 마지막 줄 색상 업데이트
        const logs = $('progress-log').children;
        if (logs.length > 0) {
            const last = logs[logs.length - 1];
            if (obj.result.status === 'ok') {
                last.className   = 'log-ok';
                last.textContent = last.textContent.replace(/^\[/, '✅ [');
            } else if (obj.result.status === 'error') {
                last.className   = 'log-error';
                last.textContent = last.textContent + ` — ❌ ${obj.result.reason}`;
            }
        }
    }

    if (obj.type === 'complete') {
        state.results = obj.results;
        renderResults();
        show('section-result');
        const ok  = state.results.filter(r => r.status === 'ok').length;
        const err = state.results.filter(r => r.status === 'error').length;
        showToast(`조회 완료 — 성공 ${ok}건, 오류 ${err}건`, ok > 0 ? 'success' : 'error', 4000);
    }
}

// ── 결과 렌더링 ───────────────────────────────────────────────────────────────

function getFilteredResults() {
    let rows = state.results;
    if ($('filter-errors-only').checked) rows = rows.filter(r => r.status === 'error');
    const q = $('filter-search').value.trim().toLowerCase();
    if (q) rows = rows.filter(r => (r.input || '').toLowerCase().includes(q) || (r.standardAddr || '').toLowerCase().includes(q));
    return rows;
}

function renderResults() {
    const rows = getFilteredResults();
    const ok   = state.results.filter(r => r.status === 'ok').length;
    const err  = state.results.filter(r => r.status === 'error').length;

    $('result-summary').textContent = `총 ${state.results.length}건 | 성공 ${ok} | 오류 ${err}`;

    $('result-tbody').innerHTML = rows.map((r, i) => {
        if (r.status === 'error' || r.status === 'skip') {
            return `
                <tr class="row-error">
                    <td class="td-num">${i + 1}</td>
                    <td class="copyable" onclick="copyCell(this)">${esc(r.input)}</td>
                    <td colspan="4" style="color:#dc2626;font-size:12px">${esc(r.reason || '-')}</td>
                    <td style="text-align:center"><span class="badge-error">❌ 오류</span></td>
                </tr>`;
        }
        return `
            <tr>
                <td class="td-num">${i + 1}</td>
                <td class="copyable" onclick="copyCell(this)">${esc(r.input)}</td>
                <td class="copyable" onclick="copyCell(this)">${esc(r.standardAddr)}</td>
                <td class="copyable" onclick="copyCell(this)">${esc(r.buildingName)}</td>
                <td class="copyable" onclick="copyCell(this)" style="font-size:12px;color:#64748b">${esc(r.rawPurpose)}</td>
                <td class="copyable" onclick="copyCell(this)"><strong>${esc(r.mappedPurpose)}</strong></td>
                <td style="text-align:center"><span class="badge-ok">✅</span></td>
            </tr>`;
    }).join('');
}

// ── 셀 복사 ───────────────────────────────────────────────────────────────────

window.copyCell = function(td) {
    const text = td.innerText.trim();
    navigator.clipboard.writeText(text).then(() => {
        td.classList.add('copied');
        setTimeout(() => td.classList.remove('copied'), 1200);
    });
};

// ── 전체 테이블 복사 (탭 구분 텍스트) ───────────────────────────────────────

$('btn-copy-table').addEventListener('click', () => {
    const rows  = getFilteredResults();
    const header = ['입력주소', '표준도로명주소', '건물명(카카오)', '주용도원본', '주용도', '상태'].join('\t');
    const body   = rows.map(r => [
        r.input, r.standardAddr || '', r.buildingName || '',
        r.rawPurpose || '', r.mappedPurpose || '', r.status
    ].join('\t')).join('\n');

    navigator.clipboard.writeText(header + '\n' + body).then(() => {
        showToast(`${rows.length}행이 클립보드에 복사됐습니다. Excel에 붙여넣기 하세요.`, 'success');
    });
});

// ── CSV 다운로드 ──────────────────────────────────────────────────────────────

$('btn-download-csv').addEventListener('click', () => {
    const rows   = state.results;
    const header = ['입력주소', '표준도로명주소', '지번주소', '건물명(카카오)', '주용도원본', '주용도', '상태', '오류내용'];
    const body   = rows.map(r => [
        r.input, r.standardAddr || '', r.jibunAddr || '',
        r.buildingName || '', r.rawPurpose || '', r.mappedPurpose || '',
        r.status, r.reason || ''
    ]);

    const csv = [header, ...body]
        .map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(','))
        .join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `건물조회_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
});

// ── 필터 ──────────────────────────────────────────────────────────────────────

$('filter-errors-only').addEventListener('change', renderResults);
$('filter-search').addEventListener('input', renderResults);

// ── 처음부터 ──────────────────────────────────────────────────────────────────

$('btn-reset').addEventListener('click', () => {
    state.results      = [];
    state.addresses    = [];
    state.fileAddresses = [];
    hide('section-progress');
    hide('section-result');
    $('input-textarea').value = '';
    $('paste-count').textContent = '0개';
    $('progress-log').innerHTML  = '';
    $('progress-bar').style.width = '0%';
});

// ── 초기화 ────────────────────────────────────────────────────────────────────

checkHealth();
