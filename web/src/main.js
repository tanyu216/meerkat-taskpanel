import { createApp } from "vue";

import App from "./App.vue";
import { applyLang, t } from "./i18n/index.js";
import { applyTheme, readLang, readTheme } from "./stores/prefs.js";
import "./styles/app.css";

// Restore the persisted theme and language before the first paint so the shell
// does not flash the wrong scheme or the wrong copy. Both readers do no I/O
// beyond `localStorage`, and both writers are the only ones that touch the
// document element.
applyTheme(readTheme());
applyLang(readLang());

const app = createApp(App);

// `$t` is the catalogue lookup bound to the active language. It is a function
// dependency of every render, so a language change re-renders what it touched.
app.config.globalProperties.$t = t;

app.mount("#app");
