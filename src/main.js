import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './styles/spa.css';
import 'vuetify/styles';
// import 'vite-plugin-vuetify/styles'; // УДАЛЕНО: такого файла нет
import { createVuetify } from 'vuetify';
import { aliases, mdi } from 'vuetify/iconsets/mdi';
import '@mdi/font/css/materialdesignicons.css';

const vuetify = createVuetify({
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },
});

const app = createApp(App);
const pinia = createPinia();
try {
  window.localStorage.removeItem('logs');
} catch {
  // Заблокированный localStorage не мешает загрузке интерфейса.
}

app.use(pinia);
app.use(router);
app.use(vuetify);
app.mount('#app');
