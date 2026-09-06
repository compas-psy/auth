import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./App";

/**
 * Состояние приходит с сервера в теге <script type="application/json">,
 * а не подтягивается вторым запросом: экран входа должен быть готов
 * сразу, вместе с юридической строкой.
 */
function readState(): Record<string, unknown> {
  const el = document.getElementById("state");
  if (!el?.textContent) return { screen: "SignIn" };
  try {
    return JSON.parse(el.textContent) as Record<string, unknown>;
  } catch {
    return { screen: "SignIn" };
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App state={readState()} />
    </StrictMode>,
  );
}
