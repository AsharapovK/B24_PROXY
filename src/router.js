import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/logs' },
  { path: '/logs', component: () => import('./pages/LogsPage.vue') },
  { path: '/chart', component: () => import('./pages/ChartPage.vue') },
  { 
    path: '/queue/status', 
    component: () => import('./pages/QueueStatusPage.vue'),
    props: route => ({ 
      itemId: route.query.dealId || route.query.invoiceId || route.query.id || route.params.id,
      searchType: route.query.dealId ? 'dealId' : 
                 route.query.invoiceId ? 'invoiceId' : 'id'
    })
  },
  // Оставляем старый маршрут для обратной совместимости
  { 
    path: '/queue/status/:id', 
    redirect: to => {
      return { path: '/queue/status', query: { id: to.params.id } }
    }
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router; 