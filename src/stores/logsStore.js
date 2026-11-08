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
    disposed: false,
    refreshTimer: null,
  }),
  actions: {
    // Этот метод теперь просто заменяет старые логи новыми
    setLogs(newLogs) {
      if (!Array.isArray(newLogs)) return;
      this.logs = newLogs;
    },

    clearData() {
      this.logs = [];
      this.queue = [];
      this.size = 0;
      this.pending = 0;
      this.totalLogs = 0;
    },

    async fetchLogs() {
      this.loading = true;
      this.error = '';
      try {
        // Убрали всю логику с `since`. Всегда запрашиваем полный, актуальный срез.
        const url = '/api/logs';
        const res = await fetch(url);
        // 401/HTTP-ошибка: не подаём устаревший срез как актуальный.
        if (!res.ok) {
          this.clearData();
          this.error = res.status === 401 ? 'Unauthorized' : `Request failed (${res.status})`;
          return;
        }
        const data = await res.json();
        if (data.success) {
          this.setLogs(data.logs); // Используем новый, простой метод
          this.queue = data.queue || [];
          this.size = data.size || 0;
          this.pending = data.pending || 0;
          this.totalLogs = data.total || 0;
        } else {
          // Успешный ответ с ошибкой: старые данные больше не актуальны.
          this.clearData();
          this.error = data.error || 'Failed to fetch logs';
        }
      } catch (e) {
        this.clearData();
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    // Сворачивает серию событий в одну загрузку.
    scheduleRefresh() {
      if (this.disposed) return;
      if (this.refreshTimer) return;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        if (this.disposed) return;
        this.fetchLogs();
      }, 750);
    },

    setupWebSocket() {
      this.cleanup();
      this.disposed = false;
      this.error = '';
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/logs/ws`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onmessage = (event) => {
          const logData = JSON.parse(event.data);
          // Серия `logs_updated` сворачивается в один отложенный fetch.
          if (logData.type === 'logs_updated') {
            this.scheduleRefresh();
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
      this.disposed = true;
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (this.ws && typeof this.ws.close === 'function') {
        this.ws.close();
        this.ws = null;
      }
    }
  }
});
