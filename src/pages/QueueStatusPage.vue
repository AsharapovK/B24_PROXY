<template>
  <div class="queue-status-page">
    <div class="container">
      <h1>Статус элемента очереди</h1>
      
      <div v-if="loading" class="loading">
        <p>Загрузка статуса...</p>
      </div>
      
      <div v-else-if="error" class="error">
        <p>Ошибка: {{ error }}</p>
        <button @click="fetchStatus" class="retry-button">Повторить</button>
      </div>
      
      <div v-else class="status-container">
        <div class="status-header">
          <h2>ID элемента: {{ itemId }}</h2>
          <div class="status-indicator" :class="statusClass">
            {{ statusText }}
          </div>
        </div>
        
        <div v-if="queueItem" class="details">
          <!-- Показываем позицию только для статуса 'queued' -->
          <div v-if="showPosition" class="detail-row">
            <span class="label">Позиция в очереди:</span>
            <span class="value">{{ queueItem.position + 1 }} (всего задач: {{ queueItem.totalInQueue || '?' }})</span>
          </div>
          
          <!-- Дополнительная информация в зависимости от статуса -->
          <template v-if="queueItem.status === 'completed'">
            <div class="detail-row">
              <span class="label">Статус:</span>
              <span class="value">Успешно завершено</span>
            </div>
            <div v-if="queueItem.completedAt" class="detail-row">
              <span class="label">Завершено в:</span>
              <span class="value">{{ formatDate(queueItem.completedAt) }}</span>
            </div>
            <div v-if="queueItem.lastEvent" class="detail-row">
              <span class="label">Результат:</span>
              <span class="value">{{ queueItem.lastEvent }}</span>
            </div>
          </template>
          
          <template v-else-if="queueItem.status === 'processing'">
            <div class="detail-row">
              <span class="label">Статус:</span>
              <span class="value">В процессе обработки</span>
            </div>
            <div v-if="queueItem.startedAt" class="detail-row">
              <span class="label">Начато в:</span>
              <span class="value">{{ formatDate(queueItem.startedAt) }}</span>
            </div>
          </template>
          
          <template v-else-if="queueItem.status === 'not_found'">
            <div class="detail-row">
              <span class="label">Статус:</span>
              <span class="value">Не найден</span>
            </div>
            <div class="detail-row">
              <span class="label">Сообщение:</span>
              <span class="value">{{ queueItem.message || 'Элемент не найден в очереди или логах' }}</span>
            </div>
          </template>
          
          <!-- Общая информация -->
          <div v-if="queueItem.timestamp" class="detail-row">
            <span class="label">Последнее обновление:</span>
            <span class="value">{{ formatDate(queueItem.timestamp) }}</span>
          </div>
          
          <div v-if="lastChecked" class="detail-row">
            <span class="label">Проверено:</span>
            <span class="value">{{ formatDate(lastChecked) }}</span>
          </div>
          
          <!-- История событий, если есть -->
          <div class="events" v-if="queueItem.events && queueItem.events.length > 0">
            <h3>История событий</h3>
            <div class="event-list">
              <div v-for="(event, index) in queueItem.events" :key="index" class="event-item" :class="'event-' + (event.type || 'info')">
                <div class="event-time">{{ formatDate(event.timestamp) }}</div>
                <div class="event-message">{{ event.message }}</div>
                <div v-if="event.attempt" class="event-attempt">Попытка #{{ event.attempt }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'QueueStatusPage',
  props: {
    itemId: {
      type: String,
      default: ''
    },
    searchType: {
      type: String,
      default: 'id',
      validator: (value) => ['id', 'dealId', 'invoiceId'].includes(value)
    }
  },
  data() {
    return {
      queueItem: null,
      loading: false,
      error: null,
      refreshInterval: null,
      lastChecked: null
    };
  },
  computed: {
    statusText() {
      if (!this.queueItem) return 'Неизвестно';
      
      switch(this.queueItem.status) {
        case 'completed':
          return 'Завершено';
        case 'processing':
          return 'В процессе обработки';
        case 'queued':
          return 'В очереди';
        case 'not_found':
          return 'Не найден';
        default:
          return 'Неизвестный статус';
      }
    },
    statusClass() {
      if (!this.queueItem) return 'status-unknown';
      
      switch(this.queueItem.status) {
        case 'completed':
          return 'status-success';
        case 'processing':
          return 'status-processing';
        case 'queued':
          return 'status-queued';
        case 'not_found':
          return 'status-unknown';
        default:
          return 'status-unknown';
      }
    },
    showPosition() {
      return this.queueItem?.status === 'queued' && this.queueItem?.position !== undefined;
    }
  },
  created() {
    this.fetchStatus();
    // Обновляем статус каждые 10 секунд
    this.refreshInterval = setInterval(this.fetchStatus, 10000);
  },
  beforeUnmount() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  },
  methods: {
    async fetchStatus() {
      if (this.loading || !this.itemId) return;
      
      this.loading = true;
      this.error = null;
      
      try {
        const params = new URLSearchParams();
        
        // Добавляем соответствующий параметр в запрос на основе searchType
        params.append(this.searchType, this.itemId);
        
        // Используем относительный URL для избежания проблем с CORS
        const url = `/api/queue/position?${params.toString()}`;
        
        // Получаем информацию о статусе запроса
        const response = await fetch(url);
        const data = await response.json();
        
        if (!response.ok) {
          throw new Error(data.message || 'Не удалось получить статус элемента');
        }
        
        // Обновляем данные о статусе
        this.queueItem = {
          ...data,
          // Сохраняем позицию как есть (может быть null для завершенных запросов)
          position: data.position,
          // Добавляем флаг успешности для совместимости со старым кодом
          success: data.status === 'completed' || data.status === 'success'
        };
        
        // Обновляем время последней проверки
        this.lastChecked = new Date().toISOString();
        
      } catch (error) {
        console.error('Ошибка при получении статуса:', error);
        this.error = error.message || 'Произошла ошибка при загрузке статуса';
        
        // Если это 404, создаем объект с статусом not_found
        if (error.message.includes('404')) {
          this.queueItem = {
            id: this.itemId,
            status: 'not_found',
            message: 'Элемент не найден в очереди или логах'
          };
        }
      } finally {
        this.loading = false;
      }
    },
    formatDate(timestamp) {
      if (!timestamp) return 'Неизвестно';
      try {
        return new Date(timestamp).toLocaleString('ru-RU');
      } catch (e) {
        return timestamp;
      }
    }
  },
  watch: {
    itemId() {
      this.fetchStatus();
    }
  }
}
</script>

<style scoped>
.queue-status-page {
  padding: 20px;
  max-width: 1000px;
  margin: 0 auto;
}

.container {
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  padding: 24px;
}

h1 {
  color: #2c3e50;
  margin-bottom: 24px;
  font-size: 24px;
}

h2 {
  color: #2c3e50;
  margin: 0;
  font-size: 20px;
}

h3 {
  color: #2c3e50;
  margin: 24px 0 12px;
  font-size: 18px;
  border-bottom: 1px solid #eee;
  padding-bottom: 8px;
}

.loading,
.error {
  text-align: center;
  padding: 40px 20px;
  font-size: 18px;
  color: #666;
}

.error {
  color: #e74c3c;
}

.retry-button {
  margin-top: 15px;
  padding: 8px 16px;
  background-color: #3498db;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.3s;
}

.retry-button:hover {
  background-color: #2980b9;
}

.status-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid #eee;
}

.status-indicator {
  padding: 6px 12px;
  border-radius: 4px;
  font-weight: 500;
  font-size: 14px;
}

.status-success {
  background-color: #d4edda;
  color: #155724;
}

.status-error {
  background-color: #f8d7da;
  color: #721c24;
}

.status-processing {
  background-color: #fff3cd;
  color: #856404;
  animation: pulse 2s infinite;
}

.status-queued {
  background-color: #e2e3e5;
  color: #383d41;
}

.status-unknown {
  background-color: #f8f9fa;
  color: #6c757d;
  border: 1px dashed #dee2e6;
}

@keyframes pulse {
  0% { opacity: 0.8; }
  50% { opacity: 1; }
  100% { opacity: 0.8; }
}

.details {
  background: #f8f9fa;
  border-radius: 6px;
  padding: 20px;
  margin-top: 20px;
}

.detail-row {
  display: flex;
  margin-bottom: 12px;
  line-height: 1.5;
}

.label {
  font-weight: 600;
  color: #495057;
  min-width: 180px;
}

.value {
  color: #212529;
  flex: 1;
}

.events {
  margin-top: 30px;
}

.event-list {
  border: 1px solid #e9ecef;
  border-radius: 6px;
  overflow: hidden;
}

.event-item {
  padding: 12px 16px;
  border-bottom: 1px solid #e9ecef;
  display: flex;
  align-items: center;
}

.event-item:last-child {
  border-bottom: none;
}

.event-time {
  color: #6c757d;
  font-size: 13px;
  min-width: 180px;
}

.event-message {
  flex: 1;
  font-size: 14px;
}

.event-attempt {
  background: #e9ecef;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  color: #495057;
  margin-left: 12px;
}

.event-error {
  background-color: #f8d7da;
  border-left: 4px solid #dc3545;
}

.event-warning {
  background-color: #fff3cd;
  border-left: 4px solid #ffc107;
}

.event-info {
  background-color: #d1ecf1;
  border-left: 4px solid #17a2b8;
}

.event-success {
  background-color: #d4edda;
  border-left: 4px solid #28a745;
}
</style>
