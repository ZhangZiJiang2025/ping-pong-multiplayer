const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ゲーム状態
const gameState = {
  seats: { left: null, right: null }, // { name, ws, lastHeartbeat }
  waitQueue: [], // [{ name, ws, lastHeartbeat }, ...]
  ball: null,
  scores: { left: 0, right: 0 },
  paddles: { left: 250, right: 250 }, // Y座標
  gameStarted: false,
  readyFlags: { left: false, right: false },
  difficulty: 'ふつう',
  gameLoopInterval: null,
  // 試合終了後の各席の選択: null（未選択） | 'rematch'（再戦） | 'leave'（退出）
  postMatchChoice: { left: null, right: null },
  postMatchTimer: null,   // 選択待ちのタイムアウトタイマー
  postMatchDeadline: null // 選択期限（クライアントに残り秒数を表示するため）
};

// 試合終了後、選択しないまま放置された場合に「退出」とみなすまでの時間（既定30秒）
const POST_MATCH_TIMEOUT_MS =
  Number(process.env.POST_MATCH_TIMEOUT_MS) > 0
    ? Number(process.env.POST_MATCH_TIMEOUT_MS)
    : 30 * 1000;

// 難易度設定
const DIFFICULTY_SETTINGS = {
  'かんたん': { initialSpeed: 3, acceleration: 0.03 },
  'ふつう': { initialSpeed: 5, acceleration: 0.05 },
  'むずかしい': { initialSpeed: 7, acceleration: 0.08 }
};

// HTTPサーバー
const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const extname = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css'
  };
  const contentType = contentTypes[extname] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('404 Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// WebSocketサーバー
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('新しい接続');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('メッセージ解析エラー:', error);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocketエラー:', error);
  });
});

// メッセージハンドラ
function handleMessage(ws, data) {
  switch (data.type) {
    case 'join':
      handleJoin(ws, data.name);
      break;
    case 'paddle':
      handlePaddleMove(ws, data.y);
      break;
    case 'ready':
      handleReady(ws);
      break;
    case 'restart':
      handleRestart(ws);
      break;
    case 'difficulty':
      handleDifficultyChange(ws, data.difficulty);
      break;
    case 'heartbeat':
      handleHeartbeat(ws, data.name);
      break;
    case 'abort':
      handleAbort(ws);
      break;
    case 'rematch':
      handlePostMatchChoice(ws, 'rematch');
      break;
    case 'leave':
      handlePostMatchChoice(ws, 'leave');
      break;
  }
}

// 参加処理
function handleJoin(ws, name) {
  // 既存の参加者を探す（再接続判定）
  const existingSeat = findSeatByName(name);
  if (existingSeat) {
    // 10秒以内なら復帰
    const seat = gameState.seats[existingSeat];
    if (seat && Date.now() - seat.lastHeartbeat < 10000) {
      seat.ws = ws;
      seat.lastHeartbeat = Date.now();
      console.log(`${name} が ${existingSeat}席に復帰`);
      broadcastState();
      return;
    }
  }

  // 新規参加
  if (!gameState.seats.left) {
    gameState.seats.left = { name, ws, lastHeartbeat: Date.now() };
    console.log(`${name} が左席に参加`);
  } else if (!gameState.seats.right) {
    gameState.seats.right = { name, ws, lastHeartbeat: Date.now() };
    console.log(`${name} が右席に参加`);
  } else {
    // 待機列に追加
    gameState.waitQueue.push({ name, ws, lastHeartbeat: Date.now() });
    console.log(`${name} が待機列に追加（${gameState.waitQueue.length}番目）`);
    // 席の交代は、対戦中の2人が「退出」を選んだときだけ発生する。
    // 待機者が増えても席の2人を強制的に入れ替えることはしない。
  }

  broadcastState();
}

// パドル移動
function handlePaddleMove(ws, y) {
  const seat = findSeatByWs(ws);
  if (seat && gameState.gameStarted) {
    gameState.paddles[seat] = Math.max(0, Math.min(500, y));
    broadcastState();
  }
}

// スタート/再スタート準備
function handleReady(ws) {
  const seat = findSeatByWs(ws);
  if (seat) {
    gameState.readyFlags[seat] = true;

    // 両方準備完了したら開始
    if (gameState.readyFlags.left && gameState.readyFlags.right) {
      startGame();
    } else {
      broadcastState();
    }
  }
}

// 再スタート処理
function handleRestart(ws) {
  handleReady(ws);
}

// 難易度変更（左席のみ）
function handleDifficultyChange(ws, difficulty) {
  const seat = findSeatByWs(ws);
  if (seat === 'left' && !gameState.gameStarted) {
    gameState.difficulty = difficulty;
    broadcastState();
  }
}

// 強制終了
function handleAbort(ws) {
  const seat = findSeatByWs(ws);
  if (seat && gameState.gameStarted) {
    // ゲームを停止
    gameState.gameStarted = false;
    gameState.ball = null;

    if (gameState.gameLoopInterval) {
      clearInterval(gameState.gameLoopInterval);
      gameState.gameLoopInterval = null;
    }

    // スコアと準備フラグをリセット
    gameState.scores = { left: 0, right: 0 };
    gameState.readyFlags = { left: false, right: false };

    console.log(`${gameState.seats[seat].name} が強制終了`);
    broadcastState();
  }
}

// ハートビート
function handleHeartbeat(ws, name) {
  const seat = findSeatByName(name);
  if (seat && gameState.seats[seat]) {
    gameState.seats[seat].lastHeartbeat = Date.now();
  }

  const queueIndex = gameState.waitQueue.findIndex(p => p.name === name);
  if (queueIndex !== -1) {
    gameState.waitQueue[queueIndex].lastHeartbeat = Date.now();
  }
}

// 切断処理
function handleDisconnect(ws) {
  const seat = findSeatByWs(ws);

  if (seat) {
    console.log(`${gameState.seats[seat].name} が切断`);
    // 10秒間は席を保持（lastHeartbeatで判定）
    // ゲームループまたは定期チェックで処理
  } else {
    // 待機列から削除
    const index = gameState.waitQueue.findIndex(p => p.ws === ws);
    if (index !== -1) {
      gameState.waitQueue.splice(index, 1);
      broadcastState();
    }
  }
}

// ゲーム開始
function startGame() {
  // 選択待ちが残っていれば終了させる（試合が始まる以上、選択は不要）
  clearPostMatchTimer();
  gameState.postMatchChoice = { left: null, right: null };

  gameState.gameStarted = true;
  gameState.readyFlags = { left: false, right: false };

  // スコアリセット（再スタート時）
  gameState.scores = { left: 0, right: 0 };

  // ボール初期化
  const settings = DIFFICULTY_SETTINGS[gameState.difficulty];
  const angle = (Math.random() * 60 - 30) * Math.PI / 180;
  const direction = Math.random() < 0.5 ? 1 : -1;

  gameState.ball = {
    x: 400,
    y: 250,
    vx: settings.initialSpeed * Math.cos(angle) * direction,
    vy: settings.initialSpeed * Math.sin(angle),
    speed: settings.initialSpeed
  };

  // ゲームループ開始
  if (gameState.gameLoopInterval) {
    clearInterval(gameState.gameLoopInterval);
  }
  gameState.gameLoopInterval = setInterval(gameLoop, 1000 / 60);

  broadcastState();
}

// ゲームループ
function gameLoop() {
  if (!gameState.gameStarted || !gameState.ball) return;

  // ボール移動
  gameState.ball.x += gameState.ball.vx;
  gameState.ball.y += gameState.ball.vy;

  // 上下の壁で反射
  if (gameState.ball.y <= 0 || gameState.ball.y >= 500) {
    gameState.ball.vy *= -1;
    gameState.ball.y = Math.max(0, Math.min(500, gameState.ball.y));
  }

  // パドルとの衝突判定
  const ballRadius = 10;
  const paddleWidth = 10;
  const paddleHeight = 80;

  // 左パドル
  if (gameState.ball.x - ballRadius <= paddleWidth &&
      gameState.ball.vx < 0 &&
      gameState.ball.y >= gameState.paddles.left &&
      gameState.ball.y <= gameState.paddles.left + paddleHeight) {
    gameState.ball.vx *= -1;
    gameState.ball.x = paddleWidth + ballRadius;

    // 加速
    const settings = DIFFICULTY_SETTINGS[gameState.difficulty];
    const speedIncrease = 1 + settings.acceleration;
    gameState.ball.vx *= speedIncrease;
    gameState.ball.vy *= speedIncrease;
  }

  // 右パドル
  if (gameState.ball.x + ballRadius >= 800 - paddleWidth &&
      gameState.ball.vx > 0 &&
      gameState.ball.y >= gameState.paddles.right &&
      gameState.ball.y <= gameState.paddles.right + paddleHeight) {
    gameState.ball.vx *= -1;
    gameState.ball.x = 800 - paddleWidth - ballRadius;

    // 加速
    const settings = DIFFICULTY_SETTINGS[gameState.difficulty];
    const speedIncrease = 1 + settings.acceleration;
    gameState.ball.vx *= speedIncrease;
    gameState.ball.vy *= speedIncrease;
  }

  // 得点判定
  if (gameState.ball.x < 0) {
    // 右側の得点
    gameState.scores.right++;
    checkWin();
  } else if (gameState.ball.x > 800) {
    // 左側の得点
    gameState.scores.left++;
    checkWin();
  }

  broadcastState();
}

// 勝利判定
function checkWin() {
  if (gameState.scores.left >= 5 || gameState.scores.right >= 5) {
    endGame();
  } else {
    // 次のラウンド
    const settings = DIFFICULTY_SETTINGS[gameState.difficulty];
    const angle = (Math.random() * 60 - 30) * Math.PI / 180;
    const direction = Math.random() < 0.5 ? 1 : -1;

    gameState.ball = {
      x: 400,
      y: 250,
      vx: settings.initialSpeed * Math.cos(angle) * direction,
      vy: settings.initialSpeed * Math.sin(angle),
      speed: settings.initialSpeed
    };
  }
}

// ゲーム終了
function endGame() {
  gameState.gameStarted = false;
  gameState.ball = null;

  if (gameState.gameLoopInterval) {
    clearInterval(gameState.gameLoopInterval);
    gameState.gameLoopInterval = null;
  }

  gameState.readyFlags = { left: false, right: false };

  // 勝敗によって自動交代はせず、両者に「再戦 / 退出」を選んでもらう
  startPostMatchChoice();
}

// 試合結果が確定済み（勝敗表示が出ている状態）かどうか
function isMatchFinished() {
  return !gameState.gameStarted && gameState.ball === null &&
         (gameState.scores.left >= 5 || gameState.scores.right >= 5);
}

// 試合終了後の選択待ちを開始する
function startPostMatchChoice() {
  gameState.postMatchChoice = { left: null, right: null };

  clearPostMatchTimer();
  gameState.postMatchDeadline = Date.now() + POST_MATCH_TIMEOUT_MS;
  gameState.postMatchTimer = setTimeout(() => {
    gameState.postMatchTimer = null;

    // 時間切れ。まだ選んでいない席だけを「退出」とみなす。
    // すでに「再戦」を選んでいる人は、その意思を尊重してここでは触らない。
    ['left', 'right'].forEach(seat => {
      if (gameState.seats[seat] && !gameState.postMatchChoice[seat]) {
        console.log(`${gameState.seats[seat].name} が時間切れのため退出扱い`);
        gameState.postMatchChoice[seat] = 'leave';
      }
    });

    resolvePostMatch();
  }, POST_MATCH_TIMEOUT_MS);

  broadcastState();
}

function clearPostMatchTimer() {
  if (gameState.postMatchTimer) {
    clearTimeout(gameState.postMatchTimer);
    gameState.postMatchTimer = null;
  }
  gameState.postMatchDeadline = null;
}

// 試合終了後の選択を受け取る（'rematch' または 'leave'）
function handlePostMatchChoice(ws, choice) {
  if (choice !== 'rematch' && choice !== 'leave') return;

  // 「退出」は試合の前後を問わず、いつでも本人の意思だけで実行できる
  if (choice === 'leave') {
    handleLeave(ws);
    return;
  }

  // 「再戦」は試合が終わった直後にだけ有効
  const seat = findSeatByWs(ws);
  if (!seat || !isMatchFinished()) return;
  if (gameState.postMatchChoice[seat]) return; // 二重選択は無視

  gameState.postMatchChoice[seat] = choice;
  console.log(`${gameState.seats[seat].name} が「再戦」を選択`);

  // 相手の同意が必要。相手がまだ選んでいなければ選択状況だけ配信して待つ
  const other = seat === 'left' ? 'right' : 'left';
  if (gameState.seats[other] && !gameState.postMatchChoice[other]) {
    broadcastState();
    return;
  }

  resolvePostMatch();
}

// 退出処理。選んだ本人だけを席（または待機列）から外し、相手はゲームに残す。
// スタート前・対戦待ち中・試合終了後に実行できる（対戦中は不可）。
function handleLeave(ws) {
  const seat = findSeatByWs(ws);

  // 待機列からの退出（対戦中かどうかに関わらずいつでも抜けられる）
  if (!seat) {
    const index = gameState.waitQueue.findIndex(p => p.ws === ws);
    if (index === -1) return;
    const player = gameState.waitQueue[index];
    gameState.waitQueue.splice(index, 1);
    console.log(`${player.name} が待機列から退出`);
    notifyRemoved(player);
    broadcastState();
    return;
  }

  // 対戦中（スタート〜試合終了まで）は席にいる人の退出を受け付けない。
  // 途中でやめたい場合は既存の「強制終了」を使う。
  // ※タブを閉じた・接続が切れた場合は従来どおりタイムアウト処理で扱う
  if (gameState.gameStarted) {
    console.log(`${gameState.seats[seat].name} の退出要求を無視（対戦中のため）`);
    return;
  }

  // 席からの退出
  const player = gameState.seats[seat];
  console.log(`${player.name} が退出（${seat}席が空席に）`);

  gameState.seats[seat] = null;
  notifyRemoved(player);

  // 選択待ちを終了させ、残った相手の選択状態もリセットする
  clearPostMatchTimer();
  gameState.postMatchChoice = { left: null, right: null };

  // 空いた席に待機列の先頭を着席させる
  if (gameState.waitQueue.length > 0) {
    const next = gameState.waitQueue.shift();
    gameState.seats[seat] = next;
    next.joinedAt = Date.now();
    console.log(`${next.name} が ${seat}席に着席（待機列の残り${gameState.waitQueue.length}人）`);
  }

  // 新しい試合の準備（残った相手もスタートを押せる状態に戻す）
  gameState.scores = { left: 0, right: 0 };
  gameState.readyFlags = { left: false, right: false };

  broadcastState();
}

// 退出したことを本人に通知する
function notifyRemoved(player) {
  if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify({ type: 'removed', reason: 'left' }));
  }
}

// 選択内容に基づいて、再戦 or 退出を確定させる。
// 「退出」を選んだ席だけを空け、それ以外の人は必ず席に残す。
function resolvePostMatch() {
  clearPostMatchTimer();

  // 退出を選んだ席だけを抽出（選んでいない席・再戦を選んだ席は対象外）
  const leaving = ['left', 'right'].filter(
    seat => gameState.seats[seat] && gameState.postMatchChoice[seat] === 'leave'
  );

  // 誰も退出しない＝同じ2人で再戦
  if (leaving.length === 0) {
    gameState.scores = { left: 0, right: 0 };
    gameState.readyFlags = { left: false, right: false };
    gameState.postMatchChoice = { left: null, right: null };
    console.log('両者が再戦を選択。同じ対戦カードで続行');
    broadcastState();
    return;
  }

  // 退出者だけを席から外す（ゲームから完全に離脱。待機列には戻さない）
  leaving.forEach(seat => {
    const player = gameState.seats[seat];
    console.log(`${player.name} が退出（${seat}席が空席に）`);
    gameState.seats[seat] = null;
    notifyRemoved(player);
  });

  // 空いた席に待機列の先頭から順に着席させる
  ['left', 'right'].forEach(seat => {
    if (!gameState.seats[seat] && gameState.waitQueue.length > 0) {
      const next = gameState.waitQueue.shift();
      gameState.seats[seat] = next;
      next.joinedAt = Date.now(); // 「入ったばかり」の案内表示に使う
      console.log(`${next.name} が ${seat}席に着席（待機列の残り${gameState.waitQueue.length}人）`);
    }
  });

  // 新しい試合の準備（残った人も、新しく入った人も未準備の状態から始める）
  gameState.scores = { left: 0, right: 0 };
  gameState.readyFlags = { left: false, right: false };
  gameState.postMatchChoice = { left: null, right: null };

  broadcastState();
}

// ヘルパー関数
function findSeatByWs(ws) {
  if (gameState.seats.left && gameState.seats.left.ws === ws) return 'left';
  if (gameState.seats.right && gameState.seats.right.ws === ws) return 'right';
  return null;
}

function findSeatByName(name) {
  if (gameState.seats.left && gameState.seats.left.name === name) return 'left';
  if (gameState.seats.right && gameState.seats.right.name === name) return 'right';
  return null;
}

// 状態ブロードキャスト
function broadcastState() {
  const state = {
    type: 'state',
    seats: {
      left: gameState.seats.left ? gameState.seats.left.name : null,
      right: gameState.seats.right ? gameState.seats.right.name : null
    },
    scores: gameState.scores,
    paddles: gameState.paddles,
    ball: gameState.ball,
    gameStarted: gameState.gameStarted,
    readyFlags: gameState.readyFlags,
    difficulty: gameState.difficulty,
    waitQueueLength: gameState.waitQueue.length,
    // 試合終了後の選択待ちかどうか（クライアントで再戦/退出ボタンを出す判定に使う）
    // 対戦相手が揃っているか（揃っていなければ「対戦待ち中」）
    hasOpponent: !!(gameState.seats.left && gameState.seats.right),
    postMatch: isMatchFinished(),
    postMatchSecondsLeft: gameState.postMatchDeadline
      ? Math.max(0, Math.ceil((gameState.postMatchDeadline - Date.now()) / 1000))
      : null
  };

  // 各クライアントに送信
  [gameState.seats.left, gameState.seats.right, ...gameState.waitQueue].forEach((player, index) => {
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
      const personalState = { ...state };

      // 自分の席を特定
      if (player === gameState.seats.left) {
        personalState.mySeat = 'left';
      } else if (player === gameState.seats.right) {
        personalState.mySeat = 'right';
      } else {
        personalState.mySeat = 'spectator';
        personalState.queuePosition = gameState.waitQueue.indexOf(player) + 1;
      }

      // 勝敗メッセージ
      if (!gameState.gameStarted && gameState.ball === null &&
          (gameState.scores.left >= 5 || gameState.scores.right >= 5)) {
        if (gameState.scores.left >= 5) {
          personalState.result = personalState.mySeat === 'left' ? 'win' :
                                  personalState.mySeat === 'right' ? 'lose' : null;
        } else {
          personalState.result = personalState.mySeat === 'right' ? 'win' :
                                  personalState.mySeat === 'left' ? 'lose' : null;
        }
      }

      // 試合終了後の選択状況（自分と相手が何を選んだか）
      if (personalState.mySeat === 'left' || personalState.mySeat === 'right') {
        const other = personalState.mySeat === 'left' ? 'right' : 'left';
        personalState.myChoice = gameState.postMatchChoice[personalState.mySeat];
        personalState.opponentChoice = gameState.seats[other]
          ? gameState.postMatchChoice[other] : null;

        // 直前に待機列から着席した人には、その旨を伝える
        if (player.joinedAt && Date.now() - player.joinedAt < 10000) {
          personalState.justSeated = true;
        }
      }

      // 相手切断メッセージ
      if (personalState.mySeat === 'left' && !state.seats.right) {
        personalState.opponentDisconnected = true;
      } else if (personalState.mySeat === 'right' && !state.seats.left) {
        personalState.opponentDisconnected = true;
      }

      player.ws.send(JSON.stringify(personalState));
    }
  });
}

// 定期的な切断チェック（10秒）
setInterval(() => {
  const now = Date.now();

  // 席の切断チェック
  ['left', 'right'].forEach(seat => {
    if (gameState.seats[seat] && now - gameState.seats[seat].lastHeartbeat > 10000) {
      console.log(`${gameState.seats[seat].name} がタイムアウト`);

      // 選択待ちの最中に接続が切れた場合は「退出」とみなす
      const wasChoosing = isMatchFinished();

      // 席を空ける
      gameState.seats[seat] = null;

      // ゲーム中なら停止
      if (gameState.gameStarted) {
        gameState.gameStarted = false;
        gameState.ball = null;
        if (gameState.gameLoopInterval) {
          clearInterval(gameState.gameLoopInterval);
          gameState.gameLoopInterval = null;
        }
      }

      if (wasChoosing) {
        // 残った側の選択を尊重したうえで決着させる
        gameState.postMatchChoice[seat] = 'leave';
        resolvePostMatch();
        return;
      }

      // 選択待ち中でなければ、従来どおりスコアを流して補充する
      clearPostMatchTimer();
      gameState.postMatchChoice = { left: null, right: null };
      gameState.scores = { left: 0, right: 0 };
      gameState.readyFlags = { left: false, right: false };

      // 待機列から補充
      if (gameState.waitQueue.length > 0) {
        const next = gameState.waitQueue.shift();
        gameState.seats[seat] = next;
        next.joinedAt = Date.now();
      }

      broadcastState();
    }
  });

  // 待機列の切断チェック
  gameState.waitQueue = gameState.waitQueue.filter(player => {
    return now - player.lastHeartbeat <= 10000;
  });
}, 2000);

server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
