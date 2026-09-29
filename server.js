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
  gameLoopInterval: null
};

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

  const winner = gameState.scores.left >= 5 ? 'left' : 'right';
  const loser = winner === 'left' ? 'right' : 'left';

  broadcastState();

  // 待機者がいる場合、負けた側を交代
  if (gameState.waitQueue.length > 0) {
    setTimeout(() => {
      const loserPlayer = gameState.seats[loser];
      const nextPlayer = gameState.waitQueue.shift();

      // 負けた側を待機列の末尾に追加
      if (loserPlayer) {
        gameState.waitQueue.push(loserPlayer);
      }

      // 次のプレイヤーを席に配置
      gameState.seats[loser] = nextPlayer;

      // スコアリセット
      gameState.scores = { left: 0, right: 0 };
      gameState.readyFlags = { left: false, right: false };

      broadcastState();
    }, 3000); // 3秒後に交代
  } else {
    // 待機者がいない場合、再戦可能（スコアはそのまま保持）
    gameState.readyFlags = { left: false, right: false };
  }
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
    waitQueueLength: gameState.waitQueue.length
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

      // スコアリセット
      gameState.scores = { left: 0, right: 0 };
      gameState.readyFlags = { left: false, right: false };

      // 待機列から補充
      if (gameState.waitQueue.length > 0) {
        gameState.seats[seat] = gameState.waitQueue.shift();
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
