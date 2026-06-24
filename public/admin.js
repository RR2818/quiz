'use strict';
const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let quizzes = [];
let current = null; // 編集中の問題セット
let roomCode = null;
let lastRanking = [];
let lastQuizTitle = '';

// =================================================================
// 問題セット エディタ
// =================================================================
function blankQuiz() {
  return { id: '', title: '', questions: [] };
}
function blankQuestion() {
  return { id: 'q_' + Math.random().toString(36).slice(2, 8), type: 'choice', text: '', choices: ['', '', '', ''], answerIndex: 0, acceptedAnswers: [] };
}

function refreshQuizList(selectId) {
  const sel = $('quizSelect');
  sel.innerHTML = '';
  const optNew = document.createElement('option');
  optNew.value = '__new__';
  optNew.textContent = '＜新規作成＞';
  sel.appendChild(optNew);
  quizzes.forEach((q) => {
    const o = document.createElement('option');
    o.value = q.id;
    o.textContent = `${q.title || '(無題)'} （${q.questions.length}問）`;
    sel.appendChild(o);
  });
  if (selectId) sel.value = selectId;
}

function loadCurrentFromSelect() {
  const id = $('quizSelect').value;
  if (id === '__new__') {
    current = blankQuiz();
  } else {
    const found = quizzes.find((q) => q.id === id);
    current = found ? JSON.parse(JSON.stringify(found)) : blankQuiz();
  }
  renderEditor();
}

function renderEditor() {
  $('quizTitle').value = current.title || '';
  const box = $('questions');
  box.innerHTML = '';
  current.questions.forEach((q, i) => box.appendChild(renderQuestion(q, i)));
}

function renderQuestion(q, i) {
  const div = document.createElement('div');
  div.className = 'q-editor';
  div.innerHTML = `
    <div class="row" style="align-items:center">
      <b style="flex:1">問 ${i + 1}</b>
      <select class="qtype" style="flex:2">
        <option value="choice">選択式</option>
        <option value="free">フリー回答</option>
      </select>
      <button class="danger qdel" style="flex:0 0 auto;padding:8px 12px">削除</button>
    </div>
    <label>問題文</label>
    <textarea class="qtext-in">${escapeHtml(q.text)}</textarea>
    <div class="choice-area"></div>
  `;
  const typeSel = div.querySelector('.qtype');
  typeSel.value = q.type;
  typeSel.addEventListener('change', () => {
    q.type = typeSel.value;
    renderChoiceArea();
  });
  div.querySelector('.qtext-in').addEventListener('input', (e) => (q.text = e.target.value));
  div.querySelector('.qdel').addEventListener('click', () => {
    current.questions.splice(i, 1);
    renderEditor();
  });

  const area = div.querySelector('.choice-area');
  function renderChoiceArea() {
    area.innerHTML = '';
    if (q.type === 'choice') {
      if (!q.choices || q.choices.length < 2) q.choices = ['', '', '', ''];
      const lbl = document.createElement('label');
      lbl.textContent = '選択肢（ラジオで正解を選択）';
      area.appendChild(lbl);
      q.choices.forEach((c, ci) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.style.alignItems = 'center';
        row.style.marginBottom = '6px';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'correct_' + q.id;
        radio.checked = q.answerIndex === ci;
        radio.style.flex = '0 0 auto';
        radio.addEventListener('change', () => (q.answerIndex = ci));
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = c;
        inp.placeholder = '選択肢 ' + (ci + 1);
        inp.style.flex = '6';
        inp.addEventListener('input', (e) => (q.choices[ci] = e.target.value));
        row.appendChild(radio);
        row.appendChild(inp);
        area.appendChild(row);
      });
    } else {
      const lbl = document.createElement('label');
      lbl.textContent = '正答（1行に1つ。略称・ひらがな等の別解も追加可）';
      area.appendChild(lbl);
      const ta = document.createElement('textarea');
      ta.value = (q.acceptedAnswers || []).join('\n');
      ta.placeholder = '例:\n琵琶湖\nびわ湖\nびわこ';
      ta.addEventListener('input', (e) => {
        q.acceptedAnswers = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
      });
      area.appendChild(ta);
      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = '※ 大文字小文字・全角半角・ひらがな/カタカナ・空白の違いは自動で吸収して判定します。';
      area.appendChild(hint);
    }
  }
  renderChoiceArea();
  return div;
}

$('quizSelect').addEventListener('change', loadCurrentFromSelect);
$('newQuizBtn').addEventListener('click', () => {
  $('quizSelect').value = '__new__';
  loadCurrentFromSelect();
});
$('quizTitle').addEventListener('input', (e) => (current.title = e.target.value));
$('addQuestionBtn').addEventListener('click', () => {
  current.questions.push(blankQuestion());
  renderEditor();
});
$('deleteQuizBtn').addEventListener('click', () => {
  if (!current.id) return toast('保存されていないセットです');
  if (!confirm('この問題セットを削除しますか？')) return;
  socket.emit('admin:deleteQuiz', current.id, (res) => {
    quizzes = res.quizzes;
    refreshQuizList('__new__');
    loadCurrentFromSelect();
    toast('削除しました');
  });
});
$('saveQuizBtn').addEventListener('click', () => {
  if (!current.title.trim()) return toast('タイトルを入力してください');
  if (!current.questions.length) return toast('問題を1問以上追加してください');
  // バリデーション
  for (let i = 0; i < current.questions.length; i++) {
    const q = current.questions[i];
    if (!q.text.trim()) return toast(`問${i + 1}: 問題文が空です`);
    if (q.type === 'choice') {
      const filled = q.choices.filter((c) => c.trim());
      if (filled.length < 2) return toast(`問${i + 1}: 選択肢を2つ以上入力してください`);
      if (!q.choices[q.answerIndex] || !q.choices[q.answerIndex].trim())
        return toast(`問${i + 1}: 正解の選択肢が空です`);
    } else {
      if (!q.acceptedAnswers || !q.acceptedAnswers.length)
        return toast(`問${i + 1}: 正答を1つ以上入力してください`);
    }
  }
  socket.emit('admin:saveQuiz', current, (res) => {
    if (!res.ok) return toast('保存失敗');
    quizzes = res.quizzes;
    current.id = res.id;
    refreshQuizList(res.id);
    toast('保存しました');
  });
});

// =================================================================
// プロジェクト開始
// =================================================================
$('launchBtn').addEventListener('click', () => {
  const id = $('quizSelect').value;
  if (id === '__new__' || !current.id) return toast('保存済みの問題セットを選択してください');
  const settings = {
    questionTime: parseInt($('questionTime').value, 10) || 0,
    sessionTime: parseInt($('sessionTime').value, 10) || 0,
  };
  socket.emit('admin:launch', { quizId: current.id, settings }, (res) => {
    if (!res || !res.ok) return toast((res && res.error) || '開始失敗');
    roomCode = res.code;
    localStorage.setItem('admin_room', roomCode);
    enterLobby();
  });
});

function enterLobby() {
  hide('editorSection');
  hide('launchSection');
  hide('controlSection');
  hide('resultSection');
  show('lobbySection');
  $('roomCode').textContent = roomCode;
  const url = location.origin + '/?room=' + roomCode;
  $('joinUrl').textContent = url;
  $('qrImg').src = '/qr?data=' + encodeURIComponent(url);
}

$('startBtn').addEventListener('click', () => {
  socket.emit('admin:start', roomCode);
});

// =================================================================
// 進行制御
// =================================================================
$('revealBtn').addEventListener('click', () => socket.emit('admin:reveal', roomCode));
$('nextBtn').addEventListener('click', () => socket.emit('admin:next', roomCode));
$('endBtn').addEventListener('click', () => {
  if (confirm('プロジェクトを終了して結果を表示しますか？')) socket.emit('admin:end', roomCode);
});

socket.on('admin:state', (st) => {
  roomCode = st.code;
  lastQuizTitle = st.quizTitle;
  // 参加者リスト
  $('playerCount').textContent = st.players.length;
  $('answeredTotal').textContent = st.players.length;
  const grid = $('playersGrid');
  grid.innerHTML = '';
  st.players.forEach((p) => {
    const c = document.createElement('span');
    c.className = 'player-chip' + (p.connected ? '' : ' off');
    c.textContent = p.nickname;
    grid.appendChild(c);
  });
  $('lobbyQuizTitle').textContent = st.quizTitle;

  if (st.status === 'lobby') {
    enterLobby();
  } else if (st.status === 'question' || st.status === 'reveal') {
    enterControl(st);
  } else if (st.status === 'ended') {
    // 終了は room:ended / admin:reveal 経由で処理。最終ランキング待ち。
  }
});

let ctrlIndexShown = -1;
function enterControl(st) {
  hide('lobbySection');
  hide('editorSection');
  hide('launchSection');
  hide('resultSection');
  show('controlSection');
  $('ctrlIndex').textContent = `第 ${st.currentIndex + 1} 問 / 全 ${st.total} 問`;
  $('ctrlStatus').textContent = st.status === 'question' ? '出題中' : '解答公開中';
  $('revealBtn').disabled = st.status !== 'question';
  $('nextBtn').disabled = st.status !== 'reveal';
  $('answeredCount').textContent = st.answered || 0;

  const q = st.currentQuestion;
  if (q) {
    $('ctrlQText').textContent = q.text;
    // 出題中は管理者にだけ正解を小さく表示（読み上げ用）
    if (st.status === 'question') {
      $('ctrlAnswerArea').innerHTML = `<span class="badge">正解: ${escapeHtml(q.answerText)}</span>`;
    }
    // 新しい問題に切り替わったらランキング表示をクリア
    if (st.currentIndex !== ctrlIndexShown && st.status === 'question') {
      $('ctrlRanking').innerHTML = '';
    }
    ctrlIndexShown = st.currentIndex;
  }
}

socket.on('admin:answerCount', (d) => {
  $('answeredCount').textContent = d.answered;
  $('answeredTotal').textContent = d.total;
});

socket.on('admin:reveal', (d) => {
  let txt = '✅ 正解: ' + d.correctText;
  if (d.acceptedAnswers && d.acceptedAnswers.length > 1) {
    txt += `（別解: ${d.acceptedAnswers.slice(1).join('、')}）`;
  }
  $('ctrlAnswerArea').textContent = txt;
  renderAdminRank('ctrlRanking', d.ranking, 10);
});

function renderAdminRank(elId, ranking, limit) {
  lastRanking = ranking;
  const box = $(elId);
  box.innerHTML = '<h3>ランキング</h3>';
  const ol = document.createElement('ol');
  ol.className = 'rank-list';
  ranking.slice(0, limit).forEach((r) => {
    const li = document.createElement('li');
    li.className = `rank-item rank-${r.rank}`;
    li.innerHTML = `<span class="rank-no">${medal(r.rank)}</span>
      <span class="rank-name">${escapeHtml(r.nickname)}</span>
      <span class="rank-score">${r.score} pt</span>`;
    ol.appendChild(li);
  });
  box.appendChild(ol);
}
function medal(n) {
  return n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : n;
}

// =================================================================
// 終了・結果ボード
// =================================================================
socket.on('room:ended', (data) => {
  lastRanking = data.ranking || [];
  lastQuizTitle = data.quizTitle || lastQuizTitle;
  hide('controlSection');
  hide('lobbySection');
  hide('editorSection');
  hide('launchSection');
  show('resultSection');
  $('resultReason').textContent = data.reason || '';
  renderBoard(lastRanking);
  localStorage.removeItem('admin_room');
});

function renderBoard(ranking) {
  const box = $('boardArea');
  box.innerHTML = '';
  const ol = document.createElement('ol');
  ol.className = 'rank-list';
  ranking.forEach((r) => {
    const li = document.createElement('li');
    li.className = `rank-item rank-${r.rank}`;
    li.innerHTML = `<span class="rank-no">${medal(r.rank)}</span>
      <span class="rank-name">${escapeHtml(r.nickname)}</span>
      <span class="rank-score">${r.score} pt</span>
      <span class="muted" style="font-size:12px">正解${r.correctCount}</span>`;
    ol.appendChild(li);
  });
  box.appendChild(ol);
}

// CSV ダウンロード
$('dlCsv').addEventListener('click', () => {
  let csv = '﻿順位,ニックネーム,得点,正解数,合計回答時間(秒)\n';
  lastRanking.forEach((r) => {
    csv += `${r.rank},"${(r.nickname || '').replace(/"/g, '""')}",${r.score},${r.correctCount},${(r.totalTime / 1000).toFixed(1)}\n`;
  });
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `ranking_${lastQuizTitle || 'quiz'}.csv`);
});

// PNG ダウンロード（Canvasに描画）
$('dlPng').addEventListener('click', () => {
  const top = lastRanking.slice(0, 30);
  const W = 720;
  const rowH = 46;
  const headH = 140;
  const H = headH + top.length * rowH + 40;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#232a4d');
  g.addColorStop(1, '#0f1226');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // タイトル
  ctx.fillStyle = '#ffd24a';
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🏆 最終ランキング', W / 2, 56);
  ctx.fillStyle = '#f2f4ff';
  ctx.font = '20px sans-serif';
  ctx.fillText(lastQuizTitle || '', W / 2, 92);
  ctx.fillStyle = '#9aa3c7';
  ctx.font = '14px sans-serif';
  ctx.fillText(new Date().toLocaleString('ja-JP'), W / 2, 118);
  // 行
  ctx.textAlign = 'left';
  top.forEach((r, i) => {
    const y = headH + i * rowH;
    ctx.fillStyle = i % 2 ? '#1a1f3a' : '#232a4d';
    ctx.fillRect(40, y, W - 80, rowH - 6);
    ctx.fillStyle = r.rank === 1 ? '#ffd24a' : r.rank === 2 ? '#cfd6e6' : r.rank === 3 ? '#e0945b' : '#f2f4ff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(String(r.rank), 58, y + 30);
    ctx.fillStyle = '#f2f4ff';
    ctx.font = '20px sans-serif';
    const name = r.nickname.length > 22 ? r.nickname.slice(0, 22) + '…' : r.nickname;
    ctx.fillText(name, 110, y + 30);
    ctx.fillStyle = '#5b8cff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(r.score + ' pt', W - 58, y + 30);
    ctx.textAlign = 'left';
  });
  cv.toBlob((blob) => downloadBlob(blob, `ranking_${lastQuizTitle || 'quiz'}.png`));
});

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

$('backHome').addEventListener('click', () => location.reload());

// =================================================================
// 初期化 / 管理者の再接続
// =================================================================
socket.emit('admin:listQuizzes', (list) => {
  quizzes = list || [];
  refreshQuizList('__new__');
  loadCurrentFromSelect();
});

// リロード時、進行中ルームへ復帰
const savedRoom = localStorage.getItem('admin_room');
if (savedRoom) {
  socket.emit('admin:rejoin', savedRoom, (res) => {
    if (res && res.ok) {
      roomCode = savedRoom;
      toast('進行中のプロジェクトに復帰しました');
    } else {
      localStorage.removeItem('admin_room');
    }
  });
}
