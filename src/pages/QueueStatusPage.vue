<template>
  <div class="queue-status-page">
    <div class="container">
      <h1>Детали запроса</h1>

      <div v-if="loading" class="loading">
        <p>Загрузка данных...</p>
      </div>

      <div v-else-if="error" class="error">
        <p>Ошибка: {{ error }}</p>
        <v-btn @click="fetchStatus" color="primary" class="mt-2">Повторить</v-btn>
      </div>

      <div v-else-if="queueItem" class="log-details">
        <v-expansion-panels v-model="panel" class="mb-6">
          <v-expansion-panel class="log-group" :class="{ 'mb-3': true, 'elevation-2': true }">
            <v-expansion-panel-title class="log-group-title" style="font-size: 0.93em; min-height: 38px; padding: 0 12px">
              <div class="d-flex align-center flex-grow-1 log-group-left">
                <v-icon size="18" class="mr-2" :color="statusInfo.color">
                  {{ statusInfo.icon }}
                </v-icon>
                <b style="font-size: 1em">
                  {{ queueItem.invoiceId ? "Счет:" : queueItem.dealId ? "Сделка:" : "—" }}
                </b>
                <span class="ml-1">
                  {{ queueItem.invoiceId || queueItem.dealId || "—" }}
                </span>
                <span class="log-group-date ml-3">{{ formatDate(queueItem.timestamp) }}</span>
              </div>
              <div class="d-flex align-center log-group-right">
                <v-chip density="comfortable" rounded label class="mr-2" :aria-label="statusText" :color="statusInfo.color" text-color="white">
                  {{ capitalizeStatus(statusText) }}
                </v-chip>
                <span v-if="queueItem.duration" class="log-group-duration">
                  {{ formatDuration(queueItem.duration) }}
                </span>
              </div>
            </v-expansion-panel-title>

            <v-expansion-panel-text style="padding: 0 0 8px 0">
              <v-list v-if="queueItem.events?.length" density="compact" class="log-events log-events-mono">
                <v-list-item v-for="(event, idx) in queueItem.events" :key="idx" :class="getEventClass(event)">
                  <v-icon size="15" class="mr-1" :color="getEventStyle(event).color">{{ getEventStyle(event).icon }}</v-icon>
                  <span class="log-event-ts mr-2">{{ formatDate(event.timestamp) }}</span>
                  <span class="log-event-message" :style="{ color: getEventStyle(event).color, fontWeight: getEventStyle(event).fontWeight }">
                    <template v-if="event.type === 'response' && event.message">
                      {{ event.message.replace(/\s*\|\s*Статус:.*$/, "") }}
                    </template>
                    <template v-else>
                      {{ event.message || event.type }}
                    </template>
                  </span>
                  <template v-if="event.type === 'response' && event.status">
                    <span class="ml-2" style="color: #1976d2; font-weight: 500"> [Код: {{ event.status }}] </span>
                  </template>
                  <div v-if="event.data" class="log-json mt-1" :class="`log-json-${event.type}`">
                    <pre v-if="typeof event.data === 'object'">
                      {{ JSON.stringify(event.data, null, 2) }}
                    </pre>
                    <span v-else>{{ event.data }}</span>
                  </div>
                </v-list-item>
              </v-list>
              <v-alert v-else type="info" variant="tonal" class="ma-2"> Нет данных о событиях </v-alert>
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <!-- Дополнительная информация -->
        <v-card class="mb-4">
          <v-card-title class="text-subtitle-1 font-weight-medium">Детали запроса</v-card-title>
          <v-card-text>
            <v-list density="compact" class="pa-0">
              <v-list-item v-if="queueItem.requestId" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-identifier" class="mr-2"></v-icon>
                </template>
                <v-list-item-title>ID запроса: {{ queueItem.requestId }}</v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.dealId" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-handshake" class="mr-2"></v-icon>
                </template>
                <v-list-item-title>ID сделки: {{ queueItem.dealId }}</v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.invoiceId" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-receipt" class="mr-2"></v-icon>
                </template>
                <v-list-item-title>ID счета: {{ queueItem.invoiceId }}</v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.position !== null" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-numeric" class="mr-2"></v-icon>
                </template>
                <v-list-item-title>
                  Позиция в очереди: {{ queueItem.position + 1 }}
                  <template v-if="queueItem.position > 0"> ({{ queueItem.position }} {{ itemsBeforeText }} перед вами) </template>
                  (всего: {{ queueItem.totalInQueue || 0 }})
                </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.duration" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-timer-sand" class="mr-2"></v-icon>
                </template>
                <v-list-item-title> Длительность: {{ formatDuration(queueItem.duration) }} </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.timestamp" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-clock-time-four-outline" class="mr-2"></v-icon>
                </template>
                <v-list-item-title> Время запроса: {{ formatDate(queueItem.timestamp) }} </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.completedAt" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-check-all" class="mr-2"></v-icon>
                </template>
                <v-list-item-title> Завершено: {{ formatDate(queueItem.completedAt) }} </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.details?.lastUpdated" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-update" class="mr-2"></v-icon>
                </template>
                <v-list-item-title> Обновлено: {{ formatDate(queueItem.details.lastUpdated) }} </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.details?.attemptCount" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-repeat" class="mr-2"></v-icon>
                </template>
                <v-list-item-title> Попыток: {{ queueItem.details.attemptCount }} </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queueItem.details?.hasErrors" class="px-0">
                <template v-slot:prepend>
                  <v-icon color="error" icon="mdi-alert-circle" class="mr-2"></v-icon>
                </template>
                <v-list-item-title class="text-error"> При обработке возникли ошибки </v-list-item-title>
              </v-list-item>

              <v-list-item v-if="queuePosition !== null" class="px-0">
                <template v-slot:prepend>
                  <v-icon icon="mdi-format-list-numbered" class="mr-2"></v-icon>
                </template>
                <v-list-item-title>
                  Очередь: {{ queuePosition + 1 }}
                  <template v-if="queuePosition > 0"> ({{ queuePosition }} {{ itemsBeforeText }} перед вами) </template>
                </v-list-item-title>
              </v-list-item>
            </v-list>
          </v-card-text>
        </v-card>
      </div>

      <div v-else class="no-data">
        <p>Данные не найдены</p>
      </div>
    </div>
  </div>
</template>

<script>
import dayjs from "dayjs";

export default {
  name: "QueueStatusPage",
  props: {
    itemId: {
      type: String,
      default: "",
    },
    searchType: {
      type: String,
      default: "id",
      validator: (value) => ["id", "dealId", "invoiceId"].includes(value),
    },
  },
  data() {
    return {
      queueItem: null,
      loading: false,
      error: null,
      refreshInterval: null,
      lastChecked: null,
      panel: 0, // For expansion panel
      animatedChips: new Set(),
      queuePosition: null,
      queueLoading: false,
    };
  },
  computed: {
    itemsBeforeText() {
      const count = this.queueItem?.position || 0;
      const lastDigit = count % 10;
      const lastTwoDigits = count % 100;

      if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
        return "элементов";
      }

      switch (lastDigit) {
        case 1:
          return "элемент";
        case 2:
        case 3:
        case 4:
          return "элемента";
        default:
          return "элементов";
      }
    },
    statusMap() {
      return {
        default: { color: "grey", icon: "mdi-file-document-outline", text: "В РАБОТЕ" },
        queued: { color: "grey", icon: "mdi-clock-outline", text: "В ОЧЕРЕДИ" },
        processing: { color: "primary", icon: "mdi-progress-clock", text: "В РАБОТЕ" },
        success: { color: "success", icon: "mdi-check-circle-outline", text: "УСПЕХ" },
        success_retry: { color: "warning", icon: "mdi-check-circle-outline", text: "УСПЕХ" },
        error: { color: "error", icon: "mdi-close-circle-outline", text: "ОШИБКА" },
        not_found: { color: "error", icon: "mdi-alert-circle-outline", text: "НЕ НАЙДЕНО" },
      };
    },
    statusInfo() {
      if (!this.queueItem) {
        return this.statusMap.default;
      }

      // If item is not found, return not_found status
      if (this.queueItem.status === "not_found") {
        return this.statusMap.not_found;
      }

      // If no events, return default status
      if (!this.queueItem.events || !Array.isArray(this.queueItem.events)) {
        return this.statusMap.default;
      }

      const events = this.queueItem.events;

      // Check for successful response (status 200)
      const successfulResponse = events.find((e) => e.type === "response" && e.status === 200);
      if (successfulResponse) {
        const requestAttempts = events.filter((e) => e.type === "request").length;
        return requestAttempts > 1 ? this.statusMap.success_retry : this.statusMap.success;
      }

      // Check for error condition (retry limit reached)
      const isFailed = events.some((e) => e.message && e.message.includes("Лимит попыток исчерпан"));
      if (isFailed) {
        return this.statusMap.error;
      }

      // Check if request is in progress
      if (this.queueItem.status === "processing" || this.queueItem.inProgress) {
        const isProcessing = events.some((e) => e.type === "processing");
        return isProcessing ? this.statusMap.processing : this.statusMap.queued;
      }

      // Check if request has started
      const hasStarted = events.some((e) => e.type === "processing" || e.type === "request");
      if (!hasStarted) {
        return this.statusMap.queued;
      }

      // Default status for other cases
      return this.statusMap.default;
    },
    statusText() {
      return this.statusInfo.text;
    },
    statusClass() {
      return `status-${this.statusInfo.color}`;
    },
    statusIcon() {
      return this.statusInfo.icon;
    },
    showPosition() {
      return this.queueItem?.status === "queued" && this.queueItem?.position !== undefined;
    },
  },
  created() {
    this.fetchStatus();
    // Обновляем статус каждые 10 секунд
    this.refreshInterval = setInterval(this.fetchStatus, 10000);
  },

  beforeUnmount() {
    // Очищаем интервал при размонтировании компонента
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  },
  methods: {
    formatDuration(ms) {
      if (!ms) return "";
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      const parts = [];
      if (hours > 0) parts.push(`${hours}ч`);
      if (minutes % 60 > 0) parts.push(`${minutes % 60}м`);
      if (seconds % 60 > 0 || parts.length === 0) parts.push(`${seconds % 60}с`);

      return parts.join(" ");
    },

    getEventInfo(event) {
      const eventMap = {
        queued: { icon: "mdi-clock-outline" },
        processing: { icon: "mdi-progress-clock" },
        request: { icon: "mdi-arrow-up-bold-outline" },
        response: { icon: "mdi-check-circle-outline" },
        warn: { icon: "mdi-alert-circle-outline" },
        error: { icon: "mdi-close-circle-outline" },
        default: { icon: "mdi-information-outline" },
      };

      const eventInfo = eventMap[event.type] || eventMap.default;

      return {
        icon: eventInfo.icon,
        color: event.type === "error" ? "error" : "primary",
      };
    },

    getEventClass(event) {
      let type = event.type;

      // Определяем тип события на основе сообщения, если тип не очевиден
      if (!type || type === "info") {
        if (event.message) {
          if (event.message.includes("добавлен в очередь")) {
            type = "queued";
          } else if (event.message.includes("взят в работу")) {
            type = "processing";
          } else if (event.message.includes("Отправка")) {
            type = "request";
          } else if (event.message.includes("Ответ") || event.message.includes("успешно записаны")) {
            type = "response";
          }
        }
      }

      return `log-event log-event-${type}`;
    },

    getEventStyle(event) {
      // Определяем стиль по типу или тексту
      let type = event.type;
      let color = '';
      let fontWeight = 'normal';
      let icon = '';
      if (!type || type === 'info') {
        if (event.message) {
          if (event.message.includes('добавлен в очередь')) {
            type = 'queued';
          } else if (event.message.includes('взят в работу')) {
            type = 'processing';
          } else if (event.message.includes('Отправка')) {
            type = 'request';
          } else if (event.message.includes('Ответ') || event.message.includes('успешно записаны')) {
            type = 'response';
          } else if (event.message.toLowerCase().includes('ошибка')) {
            type = 'error';
          }
        }
      }
      switch (type) {
        case 'queued':
          color = '#757575';
          icon = 'mdi-clock-outline';
          break;
        case 'processing':
          color = '#e65100';
          icon = 'mdi-progress-clock';
          break;
        case 'request':
          color = '#1976d2';
          icon = 'mdi-arrow-up-bold-outline';
          break;
        case 'response':
          color = '#388e3c';
          icon = 'mdi-check-circle-outline';
          break;
        case 'error':
          color = '#c62828';
          icon = 'mdi-close-circle-outline';
          // fontWeight = 'bold';
          break;
        default:
          color = '#333';
          icon = 'mdi-information-outline';
      }
      return { color, fontWeight, icon };
    },

    getRequestDuration() {
      if (!this.queueItem || !this.queueItem.events || this.queueItem.events.length < 2) {
        return "";
      }

      const events = this.queueItem.events;
      const start = dayjs(events[0].timestamp);
      const end = dayjs(events[events.length - 1].timestamp);

      if (!start.isValid() || !end.isValid() || end.isBefore(start)) {
        return "";
      }

      const duration = end.diff(start, "second", true);
      return `${duration.toFixed(1)} с`;
    },

    capitalizeStatus(text) {
      if (!text) return "";
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    },
    async fetchStatus() {
      if (this.loading || !this.itemId) return;

      this.loading = true;
      this.error = null;

      try {
        let url = "/api/queue/position";
        const params = new URLSearchParams();

        if (this.itemId) {
          if (this.searchType === "id") {
            params.append("id", this.itemId);
          } else if (this.searchType === "dealId") {
            params.append("dealId", this.itemId);
          } else if (this.searchType === "invoiceId") {
            params.append("invoiceId", this.itemId);
          }
        }

        const response = await fetch(`${url}?${params.toString()}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Ошибка при получении статуса");
        }

        // Нормализуем данные для отображения
        this.queueItem = {
          ...data,
          // Обеспечиваем обратную совместимость
          id: data.requestId,
          // Нормализуем события
          events: Array.isArray(data.events) ? data.events : [],
        };

        this.lastChecked = new Date().toISOString();

        // Запрашиваем позицию в очереди
        await this.fetchQueuePosition();
      } finally {
        this.loading = false;
      }
    },

    async fetchQueuePosition() {
      if (!this.itemId) return;

      this.queueLoading = true;

      try {
        const response = await fetch(`/api/queue/in-progress?id=${this.itemId}`);
        const data = await response.json();

        if (response.ok && data.success) {
          this.queuePosition = data.queuePosition;
        } else {
          this.queuePosition = null;
        }
      } catch (error) {
        console.error("Ошибка при получении позиции в очереди:", error);
        this.queuePosition = null;
      } finally {
        this.queueLoading = false;
      }
    },
    formatDate(timestamp) {
      if (!timestamp) return "Неизвестно";
      try {
        return new Date(timestamp).toLocaleString("ru-RU");
      } catch (e) {
        return timestamp;
      }
    },
  },
  watch: {
    itemId() {
      this.fetchStatus();
    },
  },
};
</script>
