<template>
  <v-app>
    <v-app-bar app color="primary" dark>
      <div class="page-container app-bar-flex">
        <v-toolbar-title>b24QProxy</v-toolbar-title>
        <div class="menu-group">
          <v-btn
            v-for="item in menuItems"
            :key="item.to"
            :to="item.to"
            variant="text"
            color="white"
            :class="{ 'v-btn--active': $route.path === item.to }"
          >
            <v-icon left>{{ item.icon }}</v-icon>
            {{ item.title }}
          </v-btn>
        </div>
      </div>
    </v-app-bar>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
const route = useRoute();
const router = useRouter();
const tab = ref(route.path);
watch(() => route.path, (val) => { tab.value = val; });

const menuItems = [
  { to: '/logs', title: 'Логи', icon: 'mdi-format-list-bulleted' },
  { to: '/chart', title: 'Статистика', icon: 'mdi-chart-bar' },
];
</script>

<style scoped>
.menu-group {
  display: flex;
  align-items: center;
}
.menu-group .v-btn {
  margin-left: 8px;
  margin-right: 8px;
}
.menu-group .v-btn:first-child {
  margin-left: 0;
}
.v-btn--active {
  background: rgba(255,255,255,0.15) !important;
}
</style>
