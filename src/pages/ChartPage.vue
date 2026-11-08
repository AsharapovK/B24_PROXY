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
      <p v-if="errorMessage" class="alert alert-error" role="alert">{{ errorMessage }}</p>
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
import Chart from "chart.js/auto";

const chartRef = ref(null);
const startDate = ref("");
const endDate = ref("");
const minDate = ref("");
const maxDate = ref("");
const errorMessage = ref("");
let chartInstance = null;

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setDefaultDates() {
  const todayStr = formatDate(new Date());
  startDate.value = todayStr;
  endDate.value = todayStr;
  minDate.value = "2000-01-01";
  maxDate.value = todayStr;
}

function onStartDateChange() {
  if (endDate.value && startDate.value > endDate.value) endDate.value = startDate.value;
}

function onEndDateChange() {
  if (startDate.value && endDate.value < startDate.value) endDate.value = startDate.value;
}

async function fetchStats() {
  errorMessage.value = "";
  const query = new URLSearchParams({ startDate: startDate.value, endDate: endDate.value });
  try {
    const response = await fetch(`/api/stats/chart?${query}`);
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Не удалось загрузить статистику");
    }
    renderChart(data);
  } catch (error) {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    errorMessage.value = error.message || "Не удалось загрузить статистику";
  }
}

function renderChart({ hours, success, successWithError, error, averageDurations }) {
  if (!chartRef.value) return;
  if (chartInstance) chartInstance.destroy();
  const hasData = success.some((x) => x > 0) || successWithError.some((x) => x > 0) || error.some((x) => x > 0);
  if (!hasData) {
    errorMessage.value = "Нет данных за выбранный период";
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
