import WebSocket, { WebSocketServer } from 'ws';
import { isAdminWebSocketAuthorized } from '../middlewares/adminAuth.js';

let socketServers = [];
let broadcast;

export function initWebSocketServer(...listeners) {
  socketServers = listeners.map(({ server, publicAccess = false }) => new WebSocketServer({
    server,
    path: '/api/logs/ws',
    verifyClient: ({ req }, done) => {
      if (publicAccess || isAdminWebSocketAuthorized(req.headers.authorization, req.headers.cookie)) return done(true);
      return done(false, 401, 'Unauthorized');
    },
  }));

  for (const wss of socketServers) {
    wss.on('connection', (ws) => {
      console.log('WebSocket client connected');
      ws.on('close', () => console.log('WebSocket client disconnected'));
    });
  }

  // Рассылает события всем панелям независимо от способа подключения.
  broadcast = (data) => {
    const message = JSON.stringify(data);
    for (const wss of socketServers) {
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
      });
    }
  };
}

// Геттер для функции вещания
export function getBroadcastLog() {
  return broadcast;
}
