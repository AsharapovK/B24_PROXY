import { defineStore } from 'pinia';

export const useLogsStore = defineStore('logs', {
  state: () => ({
    logs: [],
    queue: [],
    size: 0,
    pending: 0,
    totalLogs: 0,
    loading: false,
    error: '',
    ws: null,
  }),
  persist: true,
  actions: {
    // Этот метод теперь просто заменяет старые логи новыми
    setLogs(newLogs) {
      if (!Array.isArray(newLogs)) return;
      this.logs = newLogs;
    },

    async fetchLogs() {
      this.loading = true;
      this.error = '';
      try {
        // Убрали всю логику с `since`. Всегда запрашиваем полный, актуальный срез.
        const url = '/api/logs';
        const res = await fetch(url);
        const data = await res.json();
        if (data.success) {
          this.setLogs(data.logs); // Используем новый, простой метод
          this.queue = data.queue || [];
          this.size = data.size || 0;
          this.pending = data.pending || 0;
          this.totalLogs = data.total || 0;
        } else {
          this.error = data.error || 'Failed to fetch logs';
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    setupWebSocket() {
      this.cleanup();
      this.error = '';
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/logs/ws`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onmessage = (event) => {
          const logData = JSON.parse(event.data);
          // При любом сообщении от сервера, просто перезапрашиваем полный список логов
          if (logData.type === 'logs_updated') {
            this.fetchLogs();
          }
        };

        this.ws.onerror = () => { this.error = 'WebSocket connection error.'; };
        this.ws.onclose = () => { this.ws = null; };
      } catch (e) {
        this.error = `WebSocket setup failed: ${e.message}`;
        this.ws = null;
      }
    },

    cleanup() {
      if (this.ws && typeof this.ws.close === 'function') {
        this.ws.close();
        this.ws = null;
      }
    }
  }
}); 