'use strict';
const socket = io();

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
const SECTIONS = ['join', 'lobby', 'question', 'reveal', 'ended'];
function showOnly(id) {
  SECTIONS.forEach((s) => hide(s));
  show(id);
}

let state = {
  playerId: localStorage.getItem('quiz_playerId') || null,
  code: null,
  nickname: localStorage.getItem('quiz_nickname') || '',
  showAllRank: false,
  lastRanking: [],
  answeredThisQ: false,
};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// URLの ?room= からコードを取得
const params = new URLSearchParams(location.search);
const urlCode = (params.get('room') || '').toUpperCase();
if (urlCode) {
  // QRから来た場合は誤操作防止のためコードをロック（編集ボタンで解除）
  $('code').value = urlCode;
  lockCode();
} else {
  // 手入力で参加する場合は編集ボタンを隠して通常入力
  $('editCodeBtn').classList.add('hidden');
}
if (state.nickname) $('nickname').value = state.nickname;

function lockCode() {
  const el = $('code');
  el.readOnly = true;
  el.style.opacity = '0.6';
  $('editCodeBtn').classList.remove('hidden');
}
$('editCodeBtn').addEventListener('click', () => {
  const el = $('code');
  el.readOnly = false;
  el.style.opacity = '1';
  $('editCodeBtn').classList.add('hidden');
  el.focus();
  el.select();
});

// ------- 参加 -------
$('joinBtn').addEventListener('click', doJoin);
function doJoin() {
  const code = $('code').value.trim().toUpperCase();
  const nickname = $('nickname').value.trim();
  if (!code) return ($('joinError').textContent = '参加コードを入力してください');
  if (!nickname) return ($('joinError').textContent = 'ニックネームを入力してください');
  $('joinError').textContent = '';
  localStorage.setItem('quiz_nickname', nickname);
  socket.emit('player:join', { code, nickname, playerId: state.playerId }, (res) => {
    if (!res || !res.ok) return ($('joinError').textContent = (res && res.error) || '参加できませんでした');
    state.playerId = res.playerId;
    state.code = code;
    state.nickname = nickname;
    localStorage.setItem('quiz_playerId', res.playerId);
    localStorage.setItem('quiz_code', code);
    $('lobbyName').textContent = nickname + ' さん';
    $('lobbyTitle').textContent = res.quizTitle || '参加完了！';
    if (res.status === 'lobby') showOnly('lobby');
  });
}

// 自動再参加（リロード時）
const savedCode = localStorage.getItem('quiz_code');
if (state.playerId && savedCode) {
  $('code').value = savedCode;
  socket.emit('player:join', { code: savedCode, nickname: state.nickname, playerId: state.playerId }, (res) => {
    if (res && res.ok) {
      state.code = savedCode;
      $('lobbyName').textContent = state.nickname + ' さん';
      $('lobbyTitle').textContent = res.quizTitle || '参加完了！';
      if (res.status === 'lobby') showOnly('lobby');
    }
  });
}

// ------- 出題 -------
let timerInterval = null;
socket.on('question:show', (q) => {
  state.answeredThisQ = false;
  showOnly('question');
  hide('answeredMsg');
  $('qIndex').textContent = `第 ${q.index + 1} 問 / 全 ${q.total} 問`;
  $('qText').textContent = q.text;

  // タイマー
  clearInterval(timerInterval);
  if (q.deadline) {
    updateTimer(q.deadline);
    timerInterval = setInterval(() => updateTimer(q.deadline), 250);
  } else {
    $('qTimer').textContent = '';
  }

  if (q.type === 'choice') {
    show('qChoices');
    hide('qFree');
    const box = $('qChoices');
    box.innerHTML = '';
    q.choices.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = `choice-btn c${i}`;
      b.textContent = c;
      b.addEventListener('click', () => submitChoice(i, b));
      box.appendChild(b);
    });
  } else {
    hide('qChoices');
    show('qFree');
    $('freeInput').value = '';
    $('freeInput').disabled = false;
    $('freeSubmit').disabled = false;
  }
});

function updateTimer(deadline) {
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const el = $('qTimer');
  el.textContent = '⏱ ' + left;
  el.classList.toggle('warn', left <= 5);
  if (left <= 0) clearInterval(timerInterval);
}

function submitChoice(i, btn) {
  if (state.answeredThisQ) return;
  document.querySelectorAll('.choice-btn').forEach((b) => (b.disabled = true));
  btn.classList.add('selected');
  socket.emit('player:answer', { choiceIndex: i }, (res) => {
    if (!res || !res.ok) {
      toast((res && res.error) || '送信失敗');
      document.querySelectorAll('.choice-btn').forEach((b) => (b.disabled = false));
    }
  });
}

$('freeSubmit').addEventListener('click', () => {
  if (state.answeredThisQ) return;
  const text = $('freeInput').value.trim();
  if (!text) return toast('答えを入力してください');
  $('freeInput').disabled = true;
  $('freeSubmit').disabled = true;
  socket.emit('player:answer', { text }, (res) => {
    if (!res || !res.ok) {
      toast((res && res.error) || '送信失敗');
      $('freeInput').disabled = false;
      $('freeSubmit').disabled = false;
    }
  });
});

socket.on('answer:received', () => {
  state.answeredThisQ = true;
  hide('qChoices');
  hide('qFree');
  show('answeredMsg');
});

socket.on('question:timeup', () => {
  if (!state.answeredThisQ) {
    document.querySelectorAll('.choice-btn').forEach((b) => (b.disabled = true));
    $('freeInput').disabled = true;
    $('freeSubmit').disabled = true;
    toast('時間切れ');
  }
});

// ------- 結果 -------
socket.on('question:reveal', (r) => {
  clearInterval(timerInterval);
  showOnly('reveal');
  $('resultIcon').textContent = r.correct ? '⭕' : '❌';
  $('resultIcon').className = 'result-big ' + (r.correct ? 'result-ok' : 'result-ng');
  $('resultText').textContent = r.correct ? `正解！ +${r.gained} pt` : '残念…不正解';
  let ca = '正解: ' + r.correctText;
  if (r.acceptedAnswers && r.acceptedAnswers.length > 1) {
    ca += `（他の正答例: ${r.acceptedAnswers.slice(1, 4).join('、')} など）`;
  }
  if (r.yourAnswer != null && r.yourAnswer !== '') ca += ` ／ あなたの回答: ${r.yourAnswer}`;
  $('correctAnswer').textContent = ca;
  $('myRank').textContent = r.rank;
  $('myScore').textContent = r.score;
  state.lastRanking = r.ranking;
  state.showAllRank = false;
  $('toggleAll').textContent = '全員の順位を見る';
  renderRank('revealRank', r.ranking, false);
});

$('toggleAll').addEventListener('click', () => {
  state.showAllRank = !state.showAllRank;
  $('toggleAll').textContent = state.showAllRank ? '上位のみ表示' : '全員の順位を見る';
  renderRank('revealRank', state.lastRanking, state.showAllRank);
});

function renderRank(elId, ranking, all) {
  const ol = $(elId);
  ol.innerHTML = '';
  const list = all ? ranking : ranking.slice(0, 5);
  list.forEach((r) => {
    const li = document.createElement('li');
    li.className = `rank-item rank-${r.rank}` + (r.playerId === state.playerId ? ' me' : '');
    li.innerHTML = `<span class="rank-no">${medal(r.rank)}</span>
      <span class="rank-name">${escapeHtml(r.nickname)}</span>
      <span class="rank-score">${r.score} pt</span>`;
    ol.appendChild(li);
  });
}

function medal(n) {
  return n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : n;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------- 終了 -------
socket.on('room:ended', (data) => {
  showOnly('ended');
  $('endReason').textContent = data.reason || '';
  const me = (data.ranking || []).find((r) => r.playerId === state.playerId);
  $('finalRank').textContent = me ? me.rank : '-';
  $('finalScore').textContent = me ? me.score : 0;
  renderRank('finalRank2', data.ranking, true);
});

socket.on('room:closed', () => {
  toast('ルームが閉じられました');
  localStorage.removeItem('quiz_code');
});
