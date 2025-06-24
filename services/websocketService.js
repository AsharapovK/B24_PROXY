import WebSocket, { WebSocketServer } from 'ws';

let wss;
let broadcast;

export function initWebSocketServer(server) {
  wss = new WebSocketServer({ server, path: '/api/logs/ws' });

  wss.on('connection', ws => {
    console.log('WebSocket client connected');
    ws.on('close', () => console.log('WebSocket client disconnected'));
  });

  // Функция для рассылки сообщений всем клиентам
  broadcast = (data) => {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };
}

// Геттер для функции вещания
export function getBroadcastLog() {
  return broadcast;
} 