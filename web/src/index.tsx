import "@fontsource-variable/manrope";
import { render } from "@solidjs/web";
import App from "./App";
import { locale } from "./i18n";
import "./style.css";
import "./ui.css";

document.documentElement.lang = locale;
render(() => <App />, document.getElementById("root")!);
