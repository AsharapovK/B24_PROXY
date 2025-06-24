<template>
  <div class="page-container">
    <div>
      <div class="filters">
        <button
          @click="fetchLogs"
          :disabled="loading"
        >
          <span>Обновить</span>
        </button>
        <transition name="fade-slide">
          <span
            v-if="error"
            class="alert alert-error"
            >Ошибка: {{ error }}</span
          >
        </transition>
        <div
          v-if="computedSize === 0"
          class="text-muted"
        >
          Очередь пуста
        </div>
        <div
          v-else
          class="queue-details"
        >
          <div>
            <span v-if="computedPending > 0"> В работе: {{ computedPending }} из {{ computedSize }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="loading && logs.length === 0"
        class="logs-container"
      >
        <div class="text-center py-5">
          <v-progress-circular
            indeterminate
            color="primary"
          ></v-progress-circular>
        </div>
      </div>

      <div
        v-else
        class="logs-container"
      >
        <div
          v-if="error"
          class="alert alert-error"
        >
          Ошибка: {{ error }}
        </div>
        <div
          v-else-if="logs.length === 0"
          class="alert alert-info"
        >
          Логи отсутствуют
        </div>
        <div v-else>
          <div class="mb-3">Показано {{ logs.length }} запросов</div>
          <div class="logs-group-list">
            <v-expansion-panels
              v-for="log in sortedLogs"
              :key="log.id"
              v-model="openedPanels"
              multiple
              elevation="0"
              class="log-group-panels"
            >
              <v-expansion-panel
                :value="log.id"
                class="log-group mb-3"
                style="border-radius: 10px"
              >
                <v-expansion-panel-title
                  class="d-flex align-center justify-space-between log-group-title"
                  style="font-size: 0.93em; min-height: 38px; padding: 0 12px"
                >
                  <div class="d-flex align-center flex-grow-1 log-group-left">
                    <v-icon
                      size="18"
                      class="mr-2"
                      :color="getStatusInfo(log).color"
                    >
                      {{ getStatusInfo(log).icon }}
                    </v-icon>
                    <b style="font-size: 1em">
                      {{ log.invoceId ? "Счет:" : (log.dealId ? "Сделка:" : "—") }}
                    </b>
                    <span class="ml-1">
                      {{ log.invoceId ? log.invoceId : (log.dealId ? log.dealId : "—") }}
                    </span>
                    <span class="log-group-date ml-3">{{ formatDate(log.events && log.events.length > 0 ? log.events[0].timestamp : log.timestamp) }}</span>
                  </div>
                  <div class="d-flex align-center log-group-right">
                    <v-chip
                      density="comfortable"
                      rounded
                      label
                      class="mr-2"
                      :aria-label="getStatusInfo(log).text"
                      :class="[{ 'status-animate': animatedChips.has(log.id) }, { 'retry-success': isRetrySuccess(log) }]"
                      :color="getStatusInfo(log).color"
                      text-color="white"
                    >
                      {{ capitalizeStatus(getStatusInfo(log).text) }}
                    </v-chip>
                    <span class="log-group-duration">{{ getRequestDuration(log) }}</span>
                  </div>
                </v-expansion-panel-title>
                <v-expansion-panel-text style="padding: 0 0 8px 0">
                  <v-list
                    density="compact"
                    class="log-events log-events-mono"
                  >
                    <v-list-item
                      v-for="(event, idx) in log.events"
                      :key="idx"
                      :class="getEventClass(event)"
                    >
                      <v-icon
                        size="15"
                        class="mr-1"
                        >{{ getEventInfo(event).icon }}</v-icon
                      >
                      <span class="log-event-ts mr-2">{{ formatDate(event.timestamp) }}</span>
                      <span class="log-event-message">
                        <template v-if="event.type === 'response'">
                          {{ event.message.replace(/\s*\|\s*Статус:.*$/, "") }}
                        </template>
                        <template v-else>
                          {{ event.message }}
                        </template>
                      </span>
                      <template v-if="event.type === 'response'">
                        <span
                          class="ml-2"
                          style="color: #1976d2; font-weight: 500"
                          >[Код: {{ event.status }}]</span
                        >
                        <div
                          v-if="event.data"
                          class="log-json mt-1"
                        >
                          <pre v-if="typeof event.data === 'object'">
                            {{ JSON.stringify(event.data, null, 2) }}
                          </pre>
                          <span v-else>{{ event.data }}</span>
                        </div>
                      </template>
                    </v-list-item>
                  </v-list>
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useLogsStore } from "../stores/logsStore";
import { storeToRefs } from "pinia";
import dayjs from "dayjs";

const store = useLogsStore();
const { logs, loading, error, queue, size, pending } = storeToRefs(store);
const openedPanels = ref([]);
const animatedChips = ref(new Set());

watch(
  () => store.logs,
  (newLogs, oldLogs) => {
    if (!oldLogs || oldLogs.length === 0) return;

    const oldStatusMap = new Map(oldLogs.map((log) => [log.id, getStatusInfo(log).text]));

    newLogs.forEach((newLog) => {
      const oldStatus = oldStatusMap.get(newLog.id);
      const newStatus = getStatusInfo(newLog).text;
      if (oldStatus && newStatus !== oldStatus) {
        animatedChips.value.add(newLog.id);
        setTimeout(() => {
          animatedChips.value.delete(newLog.id);
        }, 700); // Должно быть чуть больше длительности анимации
      }
    });
  },
  { deep: true }
);

const sortedLogs = computed(() => {
  return [...store.logs].sort((a, b) => {
    const getInitialTimestamp = (log) => {
      if (log.events && log.events.length > 0) {
        // Убедимся, что дата парсится корректно, особенно для разных форматов
        const ts = dayjs(log.events[0].timestamp, "DD.MM.YYYY HH:mm:ss");
        return ts.isValid() ? ts.valueOf() : 0;
      }
      const ts = dayjs(log.timestamp);
      return ts.isValid() ? ts.valueOf() : 0;
    };

    const timestampA = getInitialTimestamp(a);
    const timestampB = getInitialTimestamp(b);

    return timestampB - timestampA;
  });
});

const computedPending = computed(() => {
  // Количество логов, которые сейчас в работе
  return store.logs.filter((log) => getStatusInfo(log).text === "В РАБОТЕ").length;
});
const computedSize = computed(() => {
  // Количество логов, которые в очереди или в работе
  return store.logs.filter((log) => {
    const status = getStatusInfo(log).text;
    return status === "В ОЧЕРЕДИ" || status === "В РАБОТЕ";
  }).length;
});

function togglePanel(logId) {
  const index = openedPanels.value.indexOf(logId);
  if (index > -1) {
    openedPanels.value.splice(index, 1);
  } else {
    openedPanels.value.push(logId);
  }
}

function fetchLogs() {
  store.fetchLogs();
}

function formatDate(dateString) {
  if (!dateString) return "";
  const date = dayjs(dateString);
  return date.isValid() ? date.format("DD.MM.YYYY HH:mm:ss") : "";
}

function getLatestTimestamp(log) {
  if (!log || !log.events || log.events.length === 0) {
    return log.timestamp;
  }
  return log.events[log.events.length - 1].timestamp;
}

function getRequestDuration(log) {
  if (!log || !log.events || log.events.length < 2) return "";
  const start = dayjs(log.events[0].timestamp);
  const end = dayjs(getLatestTimestamp(log));
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return "";
  return `${end.diff(start, "second", true).toFixed(1)} с`;
}

const statusMap = {
  default: { color: "grey", icon: "mdi-file-document-outline", text: "НЕИЗВЕСТНО" },
  queued: { color: "grey", icon: "mdi-clock-outline", text: "В ОЧЕРЕДИ" },
  processing: { color: "primary", icon: "mdi-progress-clock", text: "В РАБОТЕ" },
  success: { color: "success", icon: "mdi-check-circle-outline", text: "УСПЕХ" },
  success_retry: { color: "warning", icon: "mdi-check-circle-outline", text: "УСПЕХ" },
  error: { color: "error", icon: "mdi-close-circle-outline", text: "ОШИБКА" },
};

function getStatusInfo(log) {
  if (!log || !Array.isArray(log.events)) {
    return statusMap.default;
  }
  // Cначала проверяем конечные состояния, так как inProgress может быть false из-за ошибки
  const successfulResponse = log.events.find((e) => e.type === "response" && e.status === 200);
  if (successfulResponse) {
    const requestAttempts = log.events.filter((e) => e.type === "request").length;
    return requestAttempts > 1 ? statusMap.success_retry : statusMap.success;
  }

  const isFailed = log.events.some((e) => e.message === "Лимит попыток исчерпан");
  if (isFailed) {
    return statusMap.error;
  }

  // Если запрос еще не завершился (успехом или провалом) - смотрим на его текущий этап
  if (log.inProgress) {
    const isProcessing = log.events.some((e) => e.type === "processing");
    return isProcessing ? statusMap.processing : statusMap.queued;
  }

  // Если лог не inProgress, но и не успешный/провальный - вероятно, он в очереди, но еще не обработан
  const hasStarted = log.events.some((e) => e.type === "processing" || e.type === "request");
  if (!hasStarted) {
    return statusMap.queued;
  }

  return statusMap.default; // Для всех остальных пограничных случаев
}

function getEventClass(event) {
  const classMap = {
    queued: "log-queued",
    processing: "log-processing",
    request: "log-request",
    response: "log-response",
    warn: "log-warn",
    error: "log-error",
  };
  return ["log-event", classMap[event.type] || "log-info"];
}

function getEventInfo(event) {
  const eventMap = {
    queued: { icon: "mdi-clock-outline" },
    processing: { icon: "mdi-progress-clock" },
    request: { icon: "mdi-arrow-up-bold-outline" },
    response: { icon: "mdi-check-circle-outline" },
    warn: { icon: "mdi-alert-circle-outline" },
    error: { icon: "mdi-close-circle-outline" },
  };
  return eventMap[event.type] || { icon: "mdi-information-outline" };
}

function isRetrySuccess(log) {
  if (!log || !Array.isArray(log.events)) return false;
  const success = log.events.find((e) => e.type === "response" && e.status === 200);
  const attempts = log.events.filter((e) => e.type === "request").length;
  return !!success && attempts > 1;
}

function capitalizeStatus(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

onMounted(() => {
  store.fetchLogs();
  store.setupWebSocket();
});

onUnmounted(() => {
  store.cleanup();
});
</script>
