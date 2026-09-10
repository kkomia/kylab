import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import router from './router'

import './assets/base.css'
import './assets/themes/light.css'
import './assets/themes/dark.css'

createApp(App).use(createPinia()).use(router).mount('#app')
