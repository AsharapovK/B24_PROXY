import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', redirect: '/logs' },
  { path: '/logs', component: () => import('./pages/LogsPage.vue') },
  { path: '/chart', component: () => import('./pages/ChartPage.vue') },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router; 