// ── 사업부 기본 설정 ──────────────────────────────────────────────────────────
// 각 사업부의 Airtable Base ID / Table ID를 아래에 입력해두면
// 사이드바 빠른 설정 버튼 클릭 시 자동으로 채워집니다.

const DEPT_CONFIG = {
    기계설비: { baseId: '', tableId: '고객', nameField: '고객명', addressField: '도로명 주소', kakaoField: '건물명(카카오)', purposeField: '주용도' },
    소방:     { baseId: '', tableId: '고객', nameField: '고객명', addressField: '도로명 주소', kakaoField: '건물명(카카오)', purposeField: '주용도' },
    위험물:   { baseId: '', tableId: '고객', nameField: '고객명', addressField: '도로명 주소', kakaoField: '건물명(카카오)', purposeField: '주용도' },
    정보통신: { baseId: '', tableId: '고객', nameField: '고객명', addressField: '도로명 주소', kakaoField: '건물명(카카오)', purposeField: '주용도' },
    직무고시: { baseId: '', tableId: '고객', nameField: '고객명', addressField: '도로명 주소', kakaoField: '건물명(카카오)', purposeField: '주용도' },
};

// ── 상태 ──────────────────────────────────────────────────────────────────────

const state = {
    records:    [],   // 불러온 원본 레코드
    results:    [],   // 조회 결과
    baseId:     '',
    tableId:    '',
    fields:     {},
};

// ── DOM 참조 ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const els = {
    cfgBaseId:    $('cfg-base-id'),
    cfgTableId:   $('cfg-table-id'),
    cfgFieldName: $('cfg-field-name'),
    cfgFieldAddr: $('cfg-field-address'),
    cfgFieldKakao:$('cfg-field-kakao'),
    cfgFieldPurp: $('cfg-field-purpose'),
    cfgDelay:     $('cfg-delay'),

    btnLoad:      $('btn-load'),
    btnStartLookup: $('btn-start-lookup'),
    btnApply:     $('btn-apply'),
    btnDownload:  $('btn-download-csv'),
    btnRestart:   $('btn-restart'),
    btnSelectAll: $('btn-select-all'),
    btnDeselectAll: $('btn-deselect-all'),

    filterChanged:$('filter-changed-only'),
    filterErrors: $('filter-hide-errors'),
    chkAll:       $('chk-all'),

    previewCount: $('preview-count'),
    previewTbody: $('preview-tbody'),
    resultTbody:  $('result-tbody'),

    progressBar:  $('progress-bar'),
    progressText: $('progress-text'),
    progressLog:  $('progress-log'),

    statLoaded:   $('stat-loaded'),
    statDone:     $('stat-done'),
    statChanged:  $('stat-changed'),
    statError:    $('stat-error'),

    healthDisplay: $('health-display'),
    doneSummary:  $('done-summary'),
};

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function show(id)  { $(id).classList.remove('hidden'); }
function hide(id)  { $(id).classList.add('hidden'); }

function showToast(msg, type = 'info', duration = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.className   = `toast ${type}`;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.classList.add('hidden'); }, duration);
}

function updateStats() {
    const done    = state.results.length;
    const changed = state.results.filter(r => hasChange(r)).length;
    const errors  = state.results.filter(r => r.status === 'error').length;
    els.statLoaded.textContent  = state.records.length;
    els.statDone.textContent    = done;
    els.statChanged.textContent = changed;
    els.statError.textContent   = errors;
}

function hasChange(r) {
    if (r.status !== 'ok') return false;
    const kakaoChanged   = r.new_kakaoName && r.new_kakaoName !== r.kakaoName;
    const purposeChanged = r.new_purpose   && r.new_purpose   !== r.purpose;
    return kakaoChanged || purposeChanged;
}

function getCheckedIds() {
    return [...document.querySelectorAll('.row-chk:checked')].map(el => el.dataset.id);
}

// ── 서버 헬스 체크 ────────────────────────────────────────────────────────────

async function checkHealth() {
    try {
        const res  = await fetch('/health');
        const data = await res.json();
        const envs = data.env;
        const ok   = Object.values(envs).filter(Boolean).length;
        const total = Object.keys(envs).length;
        if (ok === total) {
            els.healthDisplay.className   = 'health-ok';
            els.healthDisplay.textContent = '✅ 모든 환경변수 설정됨';
        } else {
            const missing = Object.entries(envs).filter(([,v]) => !v).map(([k]) => k);
            els.healthDisplay.className   = 'health-warn';
            els.healthDisplay.textContent = `⚠️ 미설정: ${missing.join(', ')}`;
        }
    } catch {
        els.healthDisplay.className   = 'health-error';
        els.healthDisplay.textContent = '❌ 서버 연결 실패';
    }
}

// ── 사업부 버튼 ───────────────────────────────────────────────────────────────

document.querySelectorAll('.dept-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.dept-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cfg = DEPT_CONFIG[btn.dataset.dept];
        if (!cfg) return;
        els.cfgBaseId.value    = cfg.baseId    || '';
        els.cfgTableId.value   = cfg.tableId   || '';
        els.cfgFieldName.value = cfg.nameField  || '고객명';
        els.cfgFieldAddr.value = cfg.addressField || '도로명 주소';
        els.cfgFieldKakao.value= cfg.kakaoField || '건물명(카카오)';
        els.cfgFieldPurp.value = cfg.purposeField || '주용도';
    });
});

// ── Step 1: 레코드 불러오기 ───────────────────────────────────────────────────

els.btnLoad.addEventListener('click', async () => {
    const baseId  = els.cfgBaseId.value.trim();
    const tableId = els.cfgTableId.value.trim();
    if (!baseId || !tableId) {
        showToast('Base ID와 Table ID를 입력해주세요.', 'error'); return;
    }

    state.baseId  = baseId;
    state.tableId = tableId;
    state.fields  = {
        name:      els.cfgFieldName.value.trim(),
        address:   els.cfgFieldAddr.value.trim(),
        kakaoName: els.cfgFieldKakao.value.trim(),
        purpose:   els.cfgFieldPurp.value.trim(),
    };

    els.btnLoad.disabled = true;
    els.btnLoad.textContent = '⏳ 불러오는 중...';

    try {
        const res  = await fetch('/api/fetch-records', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseId, tableId, fields: state.fields }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        state.records = data.records;
        els.statLoaded.textContent = data.count;
        els.previewCount.textContent = `${data.count}개`;

        // 미리보기 테이블
        els.previewTbody.innerHTML = data.records.slice(0, 50).map((r, i) => `
            <tr>
                <td>${i + 1}</td>
                <td>${esc(r.name)}</td>
                <td>${esc(r.address)}</td>
                <td>${esc(r.kakaoName)}</td>
                <td>${esc(r.purpose)}</td>
            </tr>
        `).join('');
        if (data.records.length > 50) {
            els.previewTbody.innerHTML += `<tr><td colspan="5" style="text-align:center;color:#94a3b8;font-size:12px">... 외 ${data.count - 50}개 (전체 조회 시 모두 처리)</td></tr>`;
        }

        show('section-preview');
        showToast(`${data.count}개 레코드를 불러왔습니다.`, 'success');
    } catch (err) {
        showToast(`오류: ${err.message}`, 'error', 5000);
    } finally {
        els.btnLoad.disabled = false;
        els.btnLoad.textContent = '📥 레코드 불러오기';
    }
});

// ── Step 2: 건축물 데이터 조회 ───────────────────────────────────────────────

els.btnStartLookup.addEventListener('click', async () => {
    if (state.records.length === 0) { showToast('불러온 레코드가 없습니다.', 'error'); return; }

    state.results = [];
    els.btnStartLookup.disabled = true;
    show('section-progress');
    els.progressLog.innerHTML = '';

    const delayMs = parseInt(els.cfgDelay.value);

    try {
        const response = await fetch('/api/batch-lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: state.records, delayMs }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error);
        }

        const reader  = response.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 미완성 줄 보존

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const obj = JSON.parse(line.slice(6));
                handleStreamEvent(obj);
            }
        }
    } catch (err) {
        showToast(`조회 오류: ${err.message}`, 'error', 6000);
    } finally {
        els.btnStartLookup.disabled = false;
    }
});

function handleStreamEvent(obj) {
    if (obj.type === 'progress') {
        const pct = Math.round((obj.current / obj.total) * 100);
        els.progressBar.style.width = pct + '%';
        els.progressText.textContent = `${obj.current} / ${obj.total}`;
        const logLine = document.createElement('div');
        logLine.textContent = `[${obj.current}/${obj.total}] ${obj.name || ''}`;
        els.progressLog.appendChild(logLine);
        els.progressLog.scrollTop = els.progressLog.scrollHeight;
    }

    if (obj.type === 'record') {
        state.results.push(obj.result);
        updateStats();
    }

    if (obj.type === 'complete') {
        state.results = obj.results;
        updateStats();
        renderResultTable();
        show('section-result');
        showToast(`조회 완료! 변경사항 ${state.results.filter(hasChange).length}건`, 'success');
    }
}

// ── 결과 테이블 렌더링 ────────────────────────────────────────────────────────

function renderResultTable() {
    const changedOnly  = els.filterChanged.checked;
    const hideErrors   = els.filterErrors.checked;

    let rows = state.results;
    if (changedOnly)  rows = rows.filter(r => hasChange(r) || r.status === 'error');
    if (hideErrors)   rows = rows.filter(r => r.status !== 'error');

    els.resultTbody.innerHTML = rows.map((r, i) => {
        const changed = hasChange(r);
        const chk = r.status === 'ok'
            ? `<input type="checkbox" class="row-chk" data-id="${r.id}" ${changed ? 'checked' : ''}>`
            : '';

        const kakaoCell = diffCell(r.kakaoName, r.new_kakaoName, r.status);
        const purpCell  = diffCell(r.purpose,   r.new_purpose,   r.status);

        const statusHtml = r.status === 'ok'
            ? `<span class="status-ok">✅ 성공</span>`
            : r.status === 'skip'
                ? `<span class="status-skip">— 주소 없음</span>`
                : `<span class="status-error" title="${esc(r.reason)}">❌ 오류</span>`;

        return `
            <tr>
                <td>${chk}</td>
                <td>${i + 1}</td>
                <td>${esc(r.name)}</td>
                <td>${kakaoCell}</td>
                <td>${purpCell}</td>
                <td style="font-size:11px;color:#94a3b8">${esc(r.new_rawPurpose || '')}</td>
                <td>${statusHtml}</td>
            </tr>
        `;
    }).join('');
}

function diffCell(oldVal, newVal, status) {
    if (status !== 'ok') return `<span class="cell-old">${esc(oldVal || '-')}</span>`;
    const changed = newVal && newVal !== oldVal;
    if (!changed) {
        return `<span class="cell-same"><span class="cell-new">${esc(newVal || oldVal || '-')}</span></span>`;
    }
    return `
        <div class="cell-changed cell-diff-wrap">
            <span class="cell-old">${esc(oldVal || '(없음)')}</span>
            <span class="arrow">↓</span>
            <span class="cell-new">${esc(newVal)}</span>
        </div>
    `;
}

function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── 필터 변경 ──────────────────────────────────────────────────────────────────

els.filterChanged.addEventListener('change', renderResultTable);
els.filterErrors.addEventListener('change', renderResultTable);

els.btnSelectAll.addEventListener('click', () => {
    document.querySelectorAll('.row-chk').forEach(c => c.checked = true);
});
els.btnDeselectAll.addEventListener('click', () => {
    document.querySelectorAll('.row-chk').forEach(c => c.checked = false);
});
els.chkAll.addEventListener('change', e => {
    document.querySelectorAll('.row-chk').forEach(c => c.checked = e.target.checked);
});

// ── Step 4: 에어테이블 업데이트 ──────────────────────────────────────────────

els.btnApply.addEventListener('click', async () => {
    const checkedIds = getCheckedIds();
    if (checkedIds.length === 0) { showToast('선택된 항목이 없습니다.', 'error'); return; }

    const approved = state.results.filter(r => checkedIds.includes(r.id) && r.status === 'ok');
    if (approved.length === 0) { showToast('업데이트 가능한 항목이 없습니다.', 'error'); return; }

    if (!confirm(`${approved.length}개 레코드를 에어테이블에 업데이트합니다.\n계속하시겠습니까?`)) return;

    els.btnApply.disabled = true;
    els.btnApply.textContent = '⏳ 업데이트 중...';

    try {
        const res  = await fetch('/api/apply-updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baseId:   state.baseId,
                tableId:  state.tableId,
                fields:   state.fields,
                approved,
            }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        els.doneSummary.innerHTML = `
            ✅ 에어테이블 업데이트 완료!<br>
            업데이트 레코드: <strong>${data.count}개</strong><br>
            건물명(카카오) + 주용도 필드가 갱신되었습니다.
        `;
        show('section-done');
        showToast(`${data.count}개 레코드 업데이트 완료!`, 'success', 5000);
    } catch (err) {
        showToast(`업데이트 오류: ${err.message}`, 'error', 6000);
    } finally {
        els.btnApply.disabled = false;
        els.btnApply.textContent = '✅ 선택 항목 에어테이블 업데이트';
    }
});

// ── CSV 다운로드 ──────────────────────────────────────────────────────────────

els.btnDownload.addEventListener('click', () => {
    const header = ['고객명','도로명주소','건물명(카카오)_기존','건물명(카카오)_신규','주용도_기존','주용도_신규','주용도_원본','상태','오류메시지'];
    const rows   = state.results.map(r => [
        r.name, r.address, r.kakaoName, r.new_kakaoName || '',
        r.purpose, r.new_purpose || '', r.new_rawPurpose || '',
        r.status, r.reason || '',
    ]);
    const csv = [header, ...rows].map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `building_lookup_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
});

// ── 다시 시작 ──────────────────────────────────────────────────────────────────

els.btnRestart.addEventListener('click', () => {
    state.records = []; state.results = [];
    hide('section-preview'); hide('section-progress');
    hide('section-result'); hide('section-done');
    els.previewTbody.innerHTML = '';
    els.resultTbody.innerHTML  = '';
    els.progressLog.innerHTML  = '';
    els.progressBar.style.width = '0%';
    els.progressText.textContent = '0 / 0';
    updateStats();
});

// ── 초기화 ────────────────────────────────────────────────────────────────────

checkHealth();
updateStats();
