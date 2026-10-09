import { createApp } from "vue";

import App from "./App.vue";
import { applyTheme, readTheme } from "./stores/prefs.js";
import "./styles/app.css";

// Restore the persisted theme before the first paint so the shell does not
// flash the wrong scheme. `readTheme` does no I/O beyond `localStorage`.
applyTheme(readTheme());

createApp(App).mount("#app");
