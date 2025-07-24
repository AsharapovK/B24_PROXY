<template>
  <div class="page-container">
    <div class="chart-page">
      <div class="filters">
        <input
          type="date"
          v-model="startDate"
          :max="maxDate"
          :min="minDate"
          @change="onStartDateChange"
        />
        <input
          type="date"
          v-model="endDate"
          :max="maxDate"
          :min="startDate"
          @change="onEndDateChange"
        />
        <button @click="fetchStats">Применить</button>
      </div>
      <div
        class="queue-stat"
        style="margin-bottom: 10px"
      >
        <!-- В очереди: <b>{{ logsStore.queue.length }}</b> -->
      </div>
      <div class="chart-container">
        <canvas ref="chartRef"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useLogsStore } from "../stores/logsStore";
import Chart from "chart.js/auto";

const logsStore = useLogsStore();

const chartRef = ref(null);
let chartInstance = null;
const startDate = ref("");
const endDate = ref("");
const minDate = ref("");
const maxDate = ref("");

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setDefaultDates() {
  const today = new Date();
  const todayStr = formatDate(today);
  startDate.value = todayStr;
  endDate.value = todayStr;
  minDate.value = "2000-01-01";
  maxDate.value = todayStr;
}

function onStartDateChange() {
  if (endDate.value && startDate.value > endDate.value) {
    endDate.value = startDate.value;
  }
}
function onEndDateChange() {
  if (startDate.value && endDate.value < startDate.value) {
    startDate.value = endDate.value;
  }
}

function parseDate(ts) {
  if (!ts) return null;
  if (ts instanceof Date) return ts;
  const iso = Date.parse(ts);
  if (!isNaN(iso)) return new Date(iso);
  const match = ts.match(/(\d{2})\.(\d{2})\.(\d{4})[ ,T]?(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [_, d, m, y, h, min, s] = match;
    return new Date(`${y}-${m}-${d}T${h}:${min}:${s}`);
  }
  return null;
}

function isInRange(ts, start, end) {
  const d = parseDate(ts);
  if (!d) return false;
  // Сравниваем только даты (без времени)
  const dYMD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dStr = dYMD(d);
  const dStart = start ? start : null;
  const dEnd = end ? end : null;
  if (dStart && dStr < dStart) return false;
  if (dEnd && dStr > dEnd) return false;
  return true;
}

function getLogStatus(log) {
  if (!log || !log.events) return "unknown";
  const hasResponse200 = log.events.some((e) => e.type === "response" && e.status === 200);
  const hasError = log.events.some((e) => e.type === "error");
  if (hasResponse200 && hasError) return "successWithError";
  if (hasResponse200) return "success";
  if (hasError) return "error";
  return "other";
}

function getLatestTimestamp(log) {
  if (!log || !log.events || !log.events.length) {
    return log.timestamp;
  }
  return log.events[log.events.length - 1].timestamp;
}

function getRequestDurationInSeconds(log) {
  if (!log || !log.events || log.events.length < 2) return null;

  const start = parseDate(log.events[0].timestamp);
  const end = parseDate(getLatestTimestamp(log));

  if (!start || !end || end < start) return null;

  return (end.getTime() - start.getTime()) / 1000;
}

async function fetchStats() {
  await logsStore.fetchLogs();
  // Фильтрация по датам
  const filtered = logsStore.logs.filter((log) => isInRange(log.timestamp, startDate.value, endDate.value));
  // Подсчёт по часам
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const success = Array(24).fill(0);
  const successWithError = Array(24).fill(0);
  const error = Array(24).fill(0);
  const hourlyDurationSum = Array(24).fill(0);
  const hourlyDurationCount = Array(24).fill(0);

  filtered.forEach((log) => {
    const d = parseDate(log.timestamp);
    if (!d) return;
    const hour = d.getHours();
    const status = getLogStatus(log);
    if (status === "success") success[hour]++;
    else if (status === "successWithError") successWithError[hour]++;
    else if (status === "error") error[hour]++;

    const duration = getRequestDurationInSeconds(log);
    if (duration !== null) {
      hourlyDurationSum[hour] += duration;
      hourlyDurationCount[hour]++;
    }
  });

  const averageDurations = hourlyDurationSum.map((sum, i) => (hourlyDurationCount[i] > 0 ? (sum / hourlyDurationCount[i]).toFixed(1) : 0));

  renderChart({ hours, success, successWithError, error, averageDurations });
}

function renderChart({ hours, success, successWithError, error, averageDurations }) {
  if (!chartRef.value) return;
  if (chartInstance) chartInstance.destroy();
  const hasData = success.some((x) => x > 0) || successWithError.some((x) => x > 0) || error.some((x) => x > 0);
  if (!hasData) {
    alert("Нет данных за выбранный период");
    return;
  }
  chartInstance = new Chart(chartRef.value, {
    type: "bar",
    data: {
      labels: hours.map((h) => h.toString().padStart(2, "0") + ":00"),
      datasets: [
        {
          label: "Успех",
          data: success,
          backgroundColor: "rgba(76, 175, 80, .6)",
          borderColor: "rgb(76, 175, 80)",
          borderWidth: 1,
          stack: "stack1",
        },
        {
          label: "Успех с ошибками",
          data: successWithError,
          backgroundColor: "rgba(255, 193, 7, 0.7)",
          borderColor: "rgb(255, 193, 7)",
          borderWidth: 1,
          stack: "stack1",
        },
        {
          label: "Ошибка",
          data: error,
          backgroundColor: "rgba(176,0,32,.6)",
          borderColor: "rgb(176,0,32)",
          borderWidth: 1,
          stack: "stack1",
        },
        {
          type: "line",
          label: "Ср. время запроса",
          data: averageDurations,
          borderColor: "rgba(156, 39, 176, 0.4)",
          backgroundColor: "rgba(156, 39, 176, 0.2)",
          yAxisID: "yDuration",
          tension: 0.1,
          borderWidth: 0.7,
          pointRadius: 3,
          pointHoverRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: { display: true, text: "Часы" },
          stacked: true,
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Количество запросов" },
          stacked: true,
          position: "left",
        },
        yDuration: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          title: {
            display: true,
            text: "Ср. время запроса",
          },
          grid: {
            drawOnChartArea: false, // only draw grid for first Y axis
          },
        },
      },
      plugins: {
        legend: { position: "top" },
        title: { display: false },
        tooltip: {
          callbacks: {
            label: function (context) {
              const label = context.dataset.label || "";
              const value = context.raw;
              return `${label}: ${value}`;
            },
          },
        },
      },
    },
  });
}

onMounted(() => {
  setDefaultDates();
  fetchStats();
});
</script>
