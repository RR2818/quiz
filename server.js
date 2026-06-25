'use strict';

/**
 * イベント用 リアルタイムクイズ サーバー
 * - Express で静的ファイル(public/)を配信
 * - Socket.IO で参加者と管理者をリアルタイム同期
 * - 問題セットは data/quizzes.json に保存（再利用可能）
 * - 進行中のルーム(セッション)はメモリ上で管理（イベント単位の一時データ）
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const QUIZ_FILE = path.join(DATA_DIR, 'quizzes.json');

// ------------------------------------------------------------------
// 問題セットの永続化
// ------------------------------------------------------------------
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(QUIZ_FILE)) {
    const sample = [
      {
        id: 'sample',
        title: 'サンプルクイズ',
        questions: [
          {
            id: 'q1',
            type: 'choice',
            text: '日本の首都は？',
            choices: ['大阪', '東京', '京都', '札幌'],
            answerIndex: 1,
            acceptedAnswers: [],
          },
          {
            id: 'q2',
            type: 'free',
            text: '富士山の高さは何メートル？（数字のみ）',
            choices: [],
            answerIndex: 0,
            acceptedAnswers: ['3776', '3776m', '3776メートル'],
          },
          {
            id: 'q3',
            type: 'free',
            text: '日本で一番大きい湖は？',
            choices: [],
            answerIndex: 0,
            acceptedAnswers: ['琵琶湖', 'びわ湖', 'ビワコ', 'びわこ'],
          },
        ],
      },
    ];
    fs.writeFileSync(QUIZ_FILE, JSON.stringify(sample, null, 2), 'utf8');
  }
}

function loadQuizzes() {
  try {
    return JSON.parse(fs.readFileSync(QUIZ_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function saveQuizzes(list) {
  fs.writeFileSync(QUIZ_FILE, JSON.stringify(list, null, 2), 'utf8');
}

ensureData();

// ------------------------------------------------------------------
// 文字列正規化（フリー回答の判定用）
//  - 前後空白除去 / 小文字化 / 全角→半角(NFKC) / 空白除去 / ひらがな→カタカナ
// ------------------------------------------------------------------
function normalize(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

function isFreeAnswerCorrect(answer, accepted) {
  const n = normalize(answer);
  if (!n) return false;
  return (accepted || []).some((a) => normalize(a) === n);
}

// ------------------------------------------------------------------
// ルーム（進行中セッション）管理
// ------------------------------------------------------------------
const rooms = {}; // code -> room

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms[code]);
  return code;
}

function publicQuestion(room) {
  const q = room.quiz.questions[room.currentIndex];
  if (!q) return null;
  return {
    index: room.currentIndex,
    total: room.quiz.questions.length,
    type: q.type,
    text: q.text,
    choices: q.type === 'choice' ? q.choices : [],
    timeLimit: room.settings.questionTime, // 秒(0=無制限)
    deadline: room.questionDeadline || null,
  };
}

function buildRanking(room) {
  const arr = Object.values(room.players).map((p) => ({
    playerId: p.playerId,
    nickname: p.nickname,
    score: p.score,
    correctCount: p.correctCount,
    totalTime: p.totalTime,
  }));
  arr.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.totalTime !== b.totalTime) return a.totalTime - b.totalTime;
    return a.nickname.localeCompare(b.nickname);
  });
  arr.forEach((p, i) => (p.rank = i + 1));
  return arr;
}

function lobbyPlayers(room) {
  return Object.values(room.players).map((p) => ({
    playerId: p.playerId,
    nickname: p.nickname,
    connected: p.connected,
  }));
}

function adminRoomName(code) {
  return code + ':admin';
}

function adminCurrentQuestion(room) {
  if (room.status !== 'question' && room.status !== 'reveal') return null;
  const q = room.quiz.questions[room.currentIndex];
  if (!q) return null;
  return {
    index: room.currentIndex,
    type: q.type,
    text: q.text,
    choices: q.choices,
    answerText: q.type === 'choice' ? q.choices[q.answerIndex] : (q.acceptedAnswers[0] || ''),
    acceptedAnswers: q.acceptedAnswers || [],
    deadline: room.questionDeadline || null,
  };
}

// 管理者画面用: 現在の問題に対する全員の回答一覧
function currentAnswers(room) {
  return Object.values(room.players).map((p) => {
    const a = p.answers[room.currentIndex];
    return {
      playerId: p.playerId,
      nickname: p.nickname,
      answered: !!a,
      answer: a ? a.raw : null,
      correct: a ? a.correct : false,
    };
  });
}

function emitAdminState(room) {
  const answered = Object.values(room.players).filter((p) => p.answers[room.currentIndex]).length;
  const showAnswers = room.status === 'question' || room.status === 'reveal';
  io.to(adminRoomName(room.code)).emit('admin:state', {
    code: room.code,
    quizTitle: room.quiz.title,
    status: room.status,
    currentIndex: room.currentIndex,
    total: room.quiz.questions.length,
    players: lobbyPlayers(room),
    settings: room.settings,
    sessionDeadline: room.sessionDeadline || null,
    currentQuestion: adminCurrentQuestion(room),
    answered,
    answers: showAnswers ? currentAnswers(room) : [],
  });
}

function clearTimers(room) {
  if (room.questionTimer) {
    clearTimeout(room.questionTimer);
    room.questionTimer = null;
  }
}

function clearSessionTimer(room) {
  if (room.sessionTimer) {
    clearTimeout(room.sessionTimer);
    room.sessionTimer = null;
  }
}

// 現在の問題を全員に表示
function showQuestion(room) {
  clearTimers(room);
  const q = room.quiz.questions[room.currentIndex];
  if (!q) {
    endSession(room, '全問終了');
    return;
  }
  room.status = 'question';
  room.questionStart = Date.now();
  room.answersLocked = false;
  // 各プレイヤーの今回回答状態をリセット
  Object.values(room.players).forEach((p) => {
    p.answeredIndex = p.answeredIndex || {};
  });

  if (room.settings.questionTime > 0) {
    room.questionDeadline = room.questionStart + room.settings.questionTime * 1000;
    room.questionTimer = setTimeout(() => {
      room.answersLocked = true;
      io.to(room.code).emit('question:timeup', { index: room.currentIndex });
      emitAdminState(room);
    }, room.settings.questionTime * 1000);
  } else {
    room.questionDeadline = null;
  }

  io.to(room.code).emit('question:show', publicQuestion(room));
  emitAdminState(room);
}

// 解答を公開し、各自に正誤＋ランキングを通知
function revealAnswer(room) {
  clearTimers(room);
  room.status = 'reveal';
  room.answersLocked = true;
  const q = room.quiz.questions[room.currentIndex];
  const ranking = buildRanking(room);

  let correctText;
  if (q.type === 'choice') {
    correctText = q.choices[q.answerIndex];
  } else {
    correctText = (q.acceptedAnswers && q.acceptedAnswers[0]) || '';
  }

  const rankByPlayer = {};
  ranking.forEach((r) => (rankByPlayer[r.playerId] = r));

  // 各プレイヤーへ個別結果
  Object.values(room.players).forEach((p) => {
    const ans = p.answers[room.currentIndex];
    const my = rankByPlayer[p.playerId] || {};
    const payload = {
      index: room.currentIndex,
      correctText,
      acceptedAnswers: q.type === 'free' ? q.acceptedAnswers : undefined,
      yourAnswer: ans ? ans.raw : null,
      correct: ans ? ans.correct : false,
      gained: ans ? ans.points : 0,
      score: my.score || 0,
      rank: my.rank || ranking.length,
      ranking,
      total: room.quiz.questions.length,
    };
    if (p.socketId) io.to(p.socketId).emit('question:reveal', payload);
  });

  io.to(adminRoomName(room.code)).emit('admin:reveal', {
    index: room.currentIndex,
    correctText,
    acceptedAnswers: q.type === 'free' ? q.acceptedAnswers : undefined,
    ranking,
  });
  emitAdminState(room);
}

function nextQuestion(room) {
  if (room.currentIndex + 1 >= room.quiz.questions.length) {
    endSession(room, '全問終了');
    return;
  }
  room.currentIndex += 1;
  showQuestion(room);
}

function endSession(room, reason) {
  clearTimers(room);
  clearSessionTimer(room);
  room.status = 'ended';
  const ranking = buildRanking(room);
  const payload = {
    reason: reason || '終了',
    ranking,
    quizTitle: room.quiz.title,
  };
  io.to(room.code).emit('room:ended', payload);
  io.to(adminRoomName(room.code)).emit('room:ended', payload);
  emitAdminState(room);
}

// ------------------------------------------------------------------
// Express
// ------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// QRコード画像(PNG)を返す
app.get('/qr', async (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).send('no data');
  try {
    res.type('png');
    const buf = await QRCode.toBuffer(String(data), {
      width: 400,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    res.send(buf);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

const server = http.createServer(app);
const io = new Server(server);

// ------------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  // ---------- 管理者: 問題セット管理 ----------
  socket.on('admin:listQuizzes', (cb) => {
    cb && cb(loadQuizzes());
  });

  socket.on('admin:saveQuiz', (quiz, cb) => {
    const list = loadQuizzes();
    if (!quiz.id) {
      quiz.id = 'quiz_' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    }
    const idx = list.findIndex((q) => q.id === quiz.id);
    if (idx >= 0) list[idx] = quiz;
    else list.push(quiz);
    saveQuizzes(list);
    cb && cb({ ok: true, id: quiz.id, quizzes: list });
  });

  socket.on('admin:deleteQuiz', (id, cb) => {
    let list = loadQuizzes();
    list = list.filter((q) => q.id !== id);
    saveQuizzes(list);
    cb && cb({ ok: true, quizzes: list });
  });

  // ---------- 管理者: プロジェクト(ルーム)開始 ----------
  socket.on('admin:launch', (payload, cb) => {
    const { quizId, settings } = payload || {};
    const quiz = loadQuizzes().find((q) => q.id === quizId);
    if (!quiz || !quiz.questions.length) {
      return cb && cb({ ok: false, error: '有効な問題セットがありません' });
    }
    const code = makeCode();
    const s = {
      questionTime: Math.max(0, parseInt(settings && settings.questionTime, 10) || 0),
      sessionTime: Math.max(0, parseInt(settings && settings.sessionTime, 10) || 0), // 分
    };
    rooms[code] = {
      code,
      quiz: JSON.parse(JSON.stringify(quiz)),
      settings: s,
      status: 'lobby',
      currentIndex: 0,
      players: {}, // playerId -> player
      questionStart: 0,
      questionDeadline: null,
      sessionDeadline: null,
      answersLocked: false,
      questionTimer: null,
      sessionTimer: null,
    };
    socket.join(adminRoomName(code));
    socket.data.adminRoom = code;
    cb && cb({ ok: true, code });
    emitAdminState(rooms[code]);
  });

  // 管理者の再接続(ルームに復帰)
  socket.on('admin:rejoin', (code, cb) => {
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'ルームが存在しません' });
    socket.join(adminRoomName(code));
    socket.data.adminRoom = code;
    cb && cb({ ok: true });
    emitAdminState(room);
  });

  socket.on('admin:start', (code) => {
    const room = rooms[code];
    if (!room || room.status !== 'lobby') return;
    room.currentIndex = 0;
    // セッション全体の制限時間
    if (room.settings.sessionTime > 0) {
      room.sessionDeadline = Date.now() + room.settings.sessionTime * 60 * 1000;
      room.sessionTimer = setTimeout(
        () => endSession(room, '制限時間終了'),
        room.settings.sessionTime * 60 * 1000
      );
    }
    showQuestion(room);
  });

  socket.on('admin:reveal', (code) => {
    const room = rooms[code];
    if (!room || room.status !== 'question') return;
    revealAnswer(room);
  });

  socket.on('admin:next', (code) => {
    const room = rooms[code];
    if (!room || room.status !== 'reveal') return;
    nextQuestion(room);
  });

  socket.on('admin:end', (code) => {
    const room = rooms[code];
    if (!room) return;
    endSession(room, '主催者により終了');
  });

  socket.on('admin:close', (code) => {
    const room = rooms[code];
    if (!room) return;
    clearTimers(room);
    clearSessionTimer(room);
    io.to(room.code).emit('room:closed');
    delete rooms[code];
  });

  // ---------- 参加者 ----------
  socket.on('player:join', (payload, cb) => {
    const { code, nickname, playerId } = payload || {};
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return cb && cb({ ok: false, error: 'ルームが見つかりません。コードを確認してください。' });
    if (room.status === 'ended') return cb && cb({ ok: false, error: 'このクイズは終了しています。' });
    const name = (nickname || '').trim().slice(0, 20) || '名無し';

    let pid = playerId;
    let player = pid && room.players[pid];

    if (player) {
      // 再接続
      player.nickname = name;
      player.connected = true;
      player.socketId = socket.id;
    } else {
      pid = 'p_' + Date.now().toString(36) + Math.floor(Math.random() * 100000).toString(36);
      player = {
        playerId: pid,
        nickname: name,
        socketId: socket.id,
        connected: true,
        score: 0,
        correctCount: 0,
        totalTime: 0,
        answers: {}, // index -> {raw, correct, points, time}
      };
      room.players[pid] = player;
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = pid;

    cb &&
      cb({
        ok: true,
        playerId: pid,
        status: room.status,
        quizTitle: room.quiz.title,
      });

    // 現在の状態に応じて画面を同期
    if (room.status === 'question') {
      socket.emit('question:show', publicQuestion(room));
      if (player.answers[room.currentIndex]) {
        socket.emit('answer:received', { index: room.currentIndex });
      }
    } else if (room.status === 'reveal') {
      // 直近のreveal結果を再送
      const q = room.quiz.questions[room.currentIndex];
      const ranking = buildRanking(room);
      const my = ranking.find((r) => r.playerId === pid) || {};
      const ans = player.answers[room.currentIndex];
      socket.emit('question:reveal', {
        index: room.currentIndex,
        correctText: q.type === 'choice' ? q.choices[q.answerIndex] : (q.acceptedAnswers[0] || ''),
        acceptedAnswers: q.type === 'free' ? q.acceptedAnswers : undefined,
        yourAnswer: ans ? ans.raw : null,
        correct: ans ? ans.correct : false,
        gained: ans ? ans.points : 0,
        score: my.score || 0,
        rank: my.rank || ranking.length,
        ranking,
        total: room.quiz.questions.length,
      });
    }
    emitAdminState(room);
  });

  socket.on('player:answer', (payload, cb) => {
    const code = socket.data.roomCode;
    const pid = socket.data.playerId;
    const room = rooms[code];
    if (!room || room.status !== 'question' || room.answersLocked) {
      return cb && cb({ ok: false, error: '回答を受け付けていません' });
    }
    const player = room.players[pid];
    if (!player) return cb && cb({ ok: false, error: '参加情報がありません' });
    if (player.answers[room.currentIndex]) {
      return cb && cb({ ok: false, error: '回答済みです' });
    }

    const q = room.quiz.questions[room.currentIndex];
    const elapsed = Date.now() - room.questionStart;
    let correct = false;
    let raw;

    if (q.type === 'choice') {
      const idx = parseInt(payload.choiceIndex, 10);
      raw = q.choices[idx];
      correct = idx === q.answerIndex;
    } else {
      raw = (payload.text || '').toString().slice(0, 100);
      correct = isFreeAnswerCorrect(raw, q.acceptedAnswers);
    }

    let points = 0;
    if (correct) {
      // 1問正解につき 1pt（時間ボーナスなし）
      points = 1;
      player.correctCount += 1;
      player.totalTime += elapsed; // 同点時の順位付け（早押し）用に保持
    }

    player.answers[room.currentIndex] = { raw, correct, points, time: elapsed };
    player.score += points;

    cb && cb({ ok: true });
    socket.emit('answer:received', { index: room.currentIndex });

    // 管理者に回答数を通知
    const answered = Object.values(room.players).filter(
      (p) => p.answers[room.currentIndex]
    ).length;
    io.to(adminRoomName(room.code)).emit('admin:answerCount', {
      index: room.currentIndex,
      answered,
      total: Object.keys(room.players).length,
    });
    // 回答一覧をリアルタイム更新（管理者画面のみ）
    emitAdminState(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const pid = socket.data.playerId;
    if (code && rooms[code] && rooms[code].players[pid]) {
      rooms[code].players[pid].connected = false;
      emitAdminState(rooms[code]);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Quiz server running on http://localhost:${PORT}`);
  console.log(`  参加者:  http://localhost:${PORT}/`);
  console.log(`  管理画面: http://localhost:${PORT}/admin.html`);
});
